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
- **Non-string input** (`null`, `undefined`, numbers, ...) returns an empty root with a warning (`Expected a string, got number`) instead of throwing.
- As the HTML spec requires, the input is preprocessed first: a leading BOM is removed, and `\r\n` and `\r` are replaced with `\n`.

### Tags
- Tag and attribute names are **lowercased**, because HTML is case-insensitive. **Exception:** inside `<svg>` and `<math>` the case is kept, since these languages are case-sensitive (`viewBox`). Inside `<foreignObject>` the content is HTML again, as in browsers. End tags are matched case-insensitively everywhere.
- **Void elements** (`area, base, br, col, embed, hr, img, input, link, meta, source, track, wbr`) never have children and need no end tag.
- **`<tag/>` is treated as closed for any tag**, including `<div/>`. A browser ignores the slash on non-void HTML elements; we follow the author's obvious intent instead (a habit from XML/JSX).

### Attributes
- An attribute without a value (`disabled`) gets an empty string `""`, which is what browsers do.
- On **duplicate attributes the first one wins**, which is what browsers do.
- **An unclosed quote** (`<div class="a>text</div>`) makes the value run to the next matching quote, or to the end of the input, as in browsers. Guessing where the value "should" end would break valid values like `title="a > b"`. A warning points to the quote.
- Attributes are stored in an object created with `Object.create(null)`. With a plain `{}`, an attribute named `__proto__` would silently disappear, and `constructor` would look like an existing duplicate because of the inherited prototype. As a consequence, `attributes` has no `hasOwnProperty` method: use `"class" in node.attributes` or `Object.hasOwn(node.attributes, "class")`.

### Text
- Text content is **not trimmed**: leading and trailing spaces can be meaningful (`Hello <b>world</b>`).
  - This also applies when an end tag is left out: in `<ul>\n  <li>one\n  <li>two\n</ul>` the first item's text is `"one\n  "`, including the line break and indentation before the next `<li>`. This is not a bug: browsers keep exactly the same text in the DOM (`li.textContent`).
- **Whitespace-only text that contains a line break is dropped**, because that is indentation from formatting the source. A whitespace-only text without a line break (`<b>a</b> <i>b</i>`) is kept, because it is a real space between words. Inside `<pre>` and `<textarea>` all whitespace is kept.
- "Whitespace" means the HTML set `[ \t\n\r\f]`, not JS `\s`. `\s` also matches `&nbsp;` (U+00A0), and that is content.
- The check runs on the source text **before** entities are decoded, so `<div>&#10;</div>`, a line break written on purpose, is kept.
- A line break right after `<pre>` and `<textarea>` is dropped, as in browsers: it only formats the source.
- Adjacent text nodes are merged into one.

### Character references (entities)
- Decoded in text and attribute values, also inside `<textarea>` and `<title>`. **Not** decoded in `<script>`, `<style>`, comments, doctype and attribute names.
- **Named references:** about 60 of the most common ones (`&amp;`, `&lt;`, `&nbsp;`, `&copy;`, `&mdash;`, `&hellip;`, ...). The full HTML list has over 2000 names and could only be generated from the spec's `entities.json`. Any character can also be written as a number, and adding a name only requires one more line in the table. Names are case-sensitive (`&AMP;` is valid, `&Amp;` is not).
- **Without `;`**: only the legacy names from HTML 3.2 (`&amp`, `&lt`, `&copy`, `&nbsp`, ...) are decoded, and the longest legacy prefix wins (`&copyright` → `©right`), as in browsers. **In attribute values** they are not decoded before `=` or a letter/digit, so URLs like `?a=1&copy=2` stay intact.
- **Numeric references** (`&#169;`, `&#xA9;`, with or without `;`) are decoded as in browsers:
  - `&#0;`, values above U+10FFFF and surrogates (`&#xD800;`) become U+FFFD `�`, with a warning. (`String.fromCodePoint` would throw on these values.)
  - `&#128;`–`&#159;` are read as Windows-1252 (`&#128;` → `€`), because old pages used them that way.
  - The number is capped while reading, so `&#99999999999999...;` cannot overflow.
- **Kept as written:** unknown names (`&foo;`), a lone `&`, `&#;`, `&#x;`.
- The tables are `Map`s, not objects, so `&constructor;` does not find `Object.prototype.constructor`.

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
  - `<li>`, `<dt>`/`<dd>`, `<option>`/`<optgroup>`, `<tr>`, `<td>`/`<th>` are closed by a sibling of the same kind (`<tr>` also closes an open cell).
  - Both rules apply **only if the element to close is the current node** (top of the stack). Because of this, a nested `<ul>` never closes the `<li>` of an outer list.
  - These elements have optional end tags in valid HTML, so closing them implicitly (also by a parent's end tag or the end of input) gives no warning.
- **An end tag that is not open** (`</span>` without `<span>`) is ignored, with a warning.
- **An end tag that is open but not current** closes all elements above it: in `<b><i>x</b></i>`, `</b>` closes both elements and `</i>` is ignored.
- **Tags still open at the end of the input** are closed, with a warning.
- **An end tag with attributes** (`</p class="x">`) is used, and the attributes are ignored with a warning.
- **Input that ends inside a tag** (`<div class="a`) is not lost: the content read so far is kept, with a warning.

### Robustness
- The tree is built iteratively with an explicit stack, without recursion, so deeply nested input cannot overflow the call stack.
- **Nesting is limited to 512 levels**, like in Chrome's parser: deeper elements are added as siblings, with one warning. `JSON.stringify` is recursive and throws `RangeError` on trees deeper than about 2800 levels (Node 26), so without the limit the result of valid HTML could not be serialized. The limit also keeps searching the stack for an end tag cheap.
- The input is scanned in a single pass, with no regular expressions that could backtrack catastrophically.

## Known limitations
- Whitespace that contains a line break between inline elements (`<span>a</span>\n<span>b</span>`) is dropped, so the text reads `ab` while a browser shows `a b`. Telling inline from block elements depends on CSS, which cannot be known from HTML alone.
- A stray `</p>` is ignored; browsers insert an empty `<p></p>` for it. `</br>` is ignored; browsers treat it as `<br>`.
- Implicit closing only looks at the current node, so `<p><b>text<div>` puts the `<div>` inside `<b>`, while a browser closes both `<b>` and `<p>`.
- Only the most common implicit-closing rules are implemented, not the full HTML5 tree construction algorithm (no "adoption agency" for misnested formatting tags, no table foster parenting).
- Only a subset of named character references is supported. An unknown `&name;` is kept as written, while a browser may decode a legacy prefix of it (`&notit;` → `¬it;`).
- `<script>`, `<style>` and `<title>` inside `<svg>` are also read as raw text. In a browser they are regular SVG elements there. The tokenizer does not know the tree context.

## Repository structure
- `html2json.js`: the implementation.
- `index.html`: the provided page (unchanged).
- `html_samples/`: HTML files used to test the function.
- `ai_help/`: the AI conversation used while working on the task.
