# html2json

A hand-written HTML parser that converts an HTML string into a JSON tree.
No DOM parser (`DOMParser`, `innerHTML`, etc.) is used.

## Usage

Open `index.html` in a browser, paste HTML into the left field and press **Convert to JSON**.

```js
html2json('<p class="a">Hi</p>');
```

## Output format

The result is always a single `root` node, because an HTML fragment can have several top-level nodes.

```json
{
  "type": "root",
  "children": [
    {
      "type": "element",
      "tag": "p",
      "attributes": { "class": "a" },
      "children": [{ "type": "text", "content": "Hi" }]
    }
  ],
  "warnings": []
}
```

| Node type | Fields |
|---|---|
| `root` | `children`, `warnings` |
| `element` | `tag`, `attributes`, `children` |
| `text` | `content` |
| `comment` | `content` |
| `doctype` | `content` (e.g. `"html"`) |

- `attributes` and `children` are **always present** on elements (also on void elements like `<br>`), so consumers never have to check whether a field exists.
- Nodes have **no `parent` field**: it would create circular references and `JSON.stringify` would throw.
- `warnings` is a list of `{ message, line, column }` objects describing problems found in the input (unclosed tags, stray end tags, etc.). Parsing never fails because of them.
  - `line` and `column` start at 1. `\r\n` and a lone `\r` count as one line break.
  - `column` counts UTF-16 code units (the same as a JS string index), so an emoji takes 2 columns.

## Design decisions

### General
- **The input is returned as written.** `<html>`, `<head>` and `<body>` are not inserted automatically, unlike in a browser.
- **Non-string input** (`null`, `undefined`, numbers, ...) returns an empty root instead of throwing.
- As the HTML spec requires, the input is preprocessed first: a leading BOM is removed, and `\r\n` and `\r` are replaced with `\n`.

### Tags
- Tag and attribute names are **lowercased**, because HTML is case-insensitive. **Exception:** inside `<svg>` and `<math>` the case is kept, since these languages are case-sensitive (`viewBox`).
- **Void elements** (`area, base, br, col, embed, hr, img, input, link, meta, source, track, wbr`) never have children and need no end tag.
- **`<tag/>` is treated as closed for any tag**, including `<div/>`. A browser ignores the slash on non-void HTML elements; we follow the author's obvious intent instead (a habit from XML/JSX).

### Attributes
- An attribute without a value (`disabled`) gets an empty string `""`, which is what browsers do.
- On **duplicate attributes the first one wins**, which is what browsers do.
- **An unclosed quote** (`<div class="a>text</div>`) makes the value run to the next matching quote, or to the end of the input, as in browsers. Guessing where the value "should" end would break valid values like `title="a > b"`. A warning points to the quote.
- Attributes are stored in an object created with `Object.create(null)`. With a plain `{}`, an attribute named `__proto__` would silently disappear, and `constructor` would look like an existing duplicate because of the inherited prototype.

### Text
- Text content is **not trimmed**: leading and trailing spaces can be meaningful (`Hello <b>world</b>`).
- **Whitespace-only text that contains a line break is dropped**, because that is indentation from formatting the source. A whitespace-only text without a line break (`<b>a</b> <i>b</i>`) is kept, because it is a real space between words. Inside `<pre>` and `<textarea>` all whitespace is kept.
- "Whitespace" means the HTML set `[ \t\n\r\f]`, not JS `\s`. `\s` also matches `&nbsp;` (U+00A0), and that is content.
- Adjacent text nodes are merged into one.

### Character references (entities)
- Numeric (`&#169;`, `&#xA9;`) and the most common named references (`&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;`, `&nbsp;`, `&copy;`, ...) are decoded in text and attribute values.
- Unknown references (`&foo;`) and a lone `&` are kept as written.
- The full HTML list has over 2000 named references, so only a subset is supported. Adding more only requires extending the table.

### Raw text elements
- The content of `<script>` and `<style>` is kept **exactly as written**, as one text node: no tags, no entity decoding.
- The content of `<textarea>` and `<title>` contains no tags either, but entities **are** decoded (the same as in browsers).
- Raw text ends at the first `</name` (case-insensitive) followed by whitespace, `/`, `>` or the end of input. JS strings are not parsed, so `"</script>"` inside a script string ends the script, the same as in browsers (this is why `"<\/script>"` is used in JS).
- `<script />` is treated as closed (see `<tag/>` above), so no raw text follows it.

### Comments and other markup
- `<!-- ... -->` becomes a `comment` node. As in browsers, `--!>` also closes a comment, and `<!-->` / `<!--->` are empty comments. An unclosed comment runs to the end of the input, with a warning.
- `<!DOCTYPE ...>` becomes a `doctype` node (case-insensitive). `content` is the text after the keyword, e.g. `"html"`. Public and system identifiers are kept in it as written.
- Markup browsers do not understand (`<![CDATA[...]]>`, `<?xml ...?>`, `<!foo>`, `</ 3>`) becomes a comment up to the first `>`, as in browsers, with a warning.
- `</>` is ignored, as in browsers, with a warning. `</` at the end of the input is text.
- A `<` that does not start a tag (`a < b`, `<3`) is plain text.

### Invalid HTML
- **Implicit closing** for the most common cases:
  - `<p>` is closed by another `<p>` or by a block-level start tag (`div`, `ul`, `table`, `h1`–`h6`, ...).
  - `<li>`, `<option>`, `<tr>`, `<td>`/`<th>` are closed by a sibling of the same kind, but **only if the open element is the current node** (top of the stack). Because of this, a nested `<ul>` never closes the `<li>` of an outer list.
- **An end tag that is not open** (`</span>` without `<span>`) is ignored, with a warning.
- **An end tag that is open but not current** closes all elements above it: in `<b><i>x</b></i>`, `</b>` closes both elements and `</i>` is ignored.
- **Tags still open at the end of the input** are closed, with a warning.
- **Input that ends inside a tag** (`<div class="a`) is not lost: the content read so far is kept, with a warning.

### Robustness
- The tree is built iteratively with an explicit stack, without recursion, so deeply nested input cannot overflow the call stack.
- The input is scanned in a single pass, with no regular expressions that could backtrack catastrophically.

## Known limitations
- Whitespace that contains a line break between inline elements (`<span>a</span>\n<span>b</span>`) is dropped, so the text reads `ab` while a browser shows `a b`. Telling inline from block elements depends on CSS, which cannot be known from HTML alone.
- Only the most common implicit-closing rules are implemented, not the full HTML5 tree construction algorithm (no "adoption agency" for misnested formatting tags, no table foster parenting).
- Only a subset of named character references is supported.
- `<script>`, `<style>` and `<title>` inside `<svg>` are also read as raw text. In a browser they are regular SVG elements there. The tokenizer does not know the tree context.

## Repository structure
- `html2json.js`: the implementation.
- `index.html`: the provided page (unchanged).
- `html_samples/`: HTML files used to test the function.
- `ai_help/`: the AI conversation used while working on the task.
