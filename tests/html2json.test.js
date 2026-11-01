// Run from the project root with: node --test
const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { html2json } = require("../html2json.js");

const SAMPLES_DIR = path.join(__dirname, "..", "html_samples");
const MAX_ELEMENT_DEPTH = 513; // MAX_DEPTH levels plus the flattened elements on top

/* ---------- Helpers ---------- */

// Results are compared in their JSON form: that is how they are used, and it
// also checks that they can be serialized. (assert.deepStrictEqual also compares
// prototypes, so prototype-less `attributes` would never equal a plain {}.)
function parse(html) {
  return JSON.parse(JSON.stringify(html2json(html)));
}

function children(html) {
  return parse(html).children;
}

function warnings(html) {
  return parse(html).warnings.map((w) => `${w.line}:${w.column} ${w.message}`);
}

// el("p", { class: "a" }, text("x")) or el("br") - attributes are optional.
function el(tag, ...rest) {
  const attributes = rest.length > 0 && rest[0].type === undefined ? rest.shift() : {};
  return { type: "element", tag, attributes, children: rest };
}

const text = (content) => ({ type: "text", content });
const comment = (content) => ({ type: "comment", content });
const doctype = (content) => ({ type: "doctype", content });

// Rules that must hold for any result, whatever the input.
function assertValidTree(result) {
  assert.equal(result.type, "root");
  assert.ok(Array.isArray(result.children));
  assert.ok(Array.isArray(result.warnings));
  for (const w of result.warnings) {
    assert.equal(typeof w.message, "string");
    assert.ok(Number.isInteger(w.line) && w.line >= 1, `bad line in ${JSON.stringify(w)}`);
    assert.ok(Number.isInteger(w.column) && w.column >= 1, `bad column in ${JSON.stringify(w)}`);
  }

  const stack = [{ node: result, depth: 0 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop();
    assert.ok(depth <= MAX_ELEMENT_DEPTH, `element depth ${depth} is over the limit`);

    let previous = null;
    for (const child of node.children) {
      if (child.type === "element") {
        assert.ok(typeof child.tag === "string" && child.tag !== "", "element without a tag");
        assert.equal(typeof child.attributes, "object");
        for (const value of Object.values(child.attributes)) assert.equal(typeof value, "string");
        assert.ok(Array.isArray(child.children));
        stack.push({ node: child, depth: depth + 1 });
      } else if (child.type === "text") {
        assert.ok(typeof child.content === "string" && child.content !== "", "empty text node");
        assert.notEqual(previous && previous.type, "text", "adjacent text nodes are not merged");
      } else {
        assert.ok(child.type === "comment" || child.type === "doctype", `unknown node type ${child.type}`);
        assert.equal(typeof child.content, "string");
      }
      previous = child;
    }
  }
}

/* ---------- Output format ---------- */

describe("output format", () => {
  test("example 2 from index.html", () => {
    const longText =
      "Some very very very very very very very very very very very very very very very very very " +
      "very very very very very very very very very very very very very very very very very very long string.";
    const html = `<div>
<p>Hello world!</p>
  <button>Click me!</button>
  <textarea>${longText}</textarea>
</div>
`;
    assert.deepEqual(parse(html), {
      type: "root",
      children: [
        el("div",
          el("p", text("Hello world!")),
          el("button", text("Click me!")),
          el("textarea", text(longText))),
      ],
      warnings: [],
    });
  });

  test("several top-level nodes", () => {
    assert.deepEqual(children("<p>a</p><p>b</p>text"), [el("p", text("a")), el("p", text("b")), text("text")]);
  });

  test("empty and whitespace-only input", () => {
    assert.deepEqual(parse(""), { type: "root", children: [], warnings: [] });
    assert.deepEqual(parse("  \n\t\n "), { type: "root", children: [], warnings: [] });
  });

  test("plain text without tags", () => {
    assert.deepEqual(children("Just text"), [text("Just text")]);
  });

  test("non-string input does not throw", () => {
    for (const [input, type] of [[null, "null"], [undefined, "undefined"], [42, "number"], [{}, "object"]]) {
      assert.deepEqual(html2json(input), {
        type: "root",
        children: [],
        warnings: [{ message: `Expected a string, got ${type}`, line: 1, column: 1 }],
      });
    }
  });

  test("html, head and body are not added", () => {
    assert.deepEqual(children("<title>T</title><p>x</p>"), [el("title", text("T")), el("p", text("x"))]);
  });
});

/* ---------- Tags ---------- */

describe("tags", () => {
  test("void elements have no children and need no end tag", () => {
    assert.deepEqual(children("<p>a<br>b<img src=x.png>c</p>"), [
      el("p", text("a"), el("br"), text("b"), el("img", { src: "x.png" }), text("c")),
    ]);
  });

  test("<tag/> is closed for any tag", () => {
    assert.deepEqual(children("<br/><br /><div/><p>after</p>"), [el("br"), el("br"), el("div"), el("p", text("after"))]);
  });

  test("tag names are lowercased", () => {
    assert.deepEqual(children("<DIV><Span>x</SPAN></div>"), [el("div", el("span", text("x")))]);
  });

  test("whitespace and line breaks inside a tag", () => {
    assert.deepEqual(children('<div\n  class="a"\n>x</div\n>'), [el("div", { class: "a" }, text("x"))]);
  });
});

/* ---------- Attributes ---------- */

describe("attributes", () => {
  test("quoted, unquoted and without value", () => {
    assert.deepEqual(children(`<input a="1" b='2' c=3 disabled d="">`), [
      el("input", { a: "1", b: "2", c: "3", disabled: "", d: "" }),
    ]);
  });

  test("> and quotes inside values", () => {
    assert.deepEqual(children(`<div title="a > b" data-q='say "hi"' data-a="it's"></div>`), [
      el("div", { title: "a > b", "data-q": 'say "hi"', "data-a": "it's" }),
    ]);
  });

  test("spaces around = and no space between attributes", () => {
    assert.deepEqual(children(`<div class = "a" x="1"y="2"></div>`), [el("div", { class: "a", x: "1", y: "2" })]);
  });

  test("/ belongs to an unquoted value", () => {
    assert.deepEqual(children("<a href=/path/>x</a>"), [el("a", { href: "/path/" }, text("x"))]);
  });

  test("= as the first character is part of the name", () => {
    assert.deepEqual(children("<div =broken></div>"), [el("div", { "=broken": "" })]);
  });

  test("names are lowercased, the first duplicate wins", () => {
    const html = `<a HREF="1" href="2" Href="3">x</a>`;
    assert.deepEqual(children(html), [el("a", { href: "1" }, text("x"))]);
    assert.deepEqual(warnings(html), [
      '1:1 Duplicate attribute "href" on <a> is ignored',
      '1:1 Duplicate attribute "href" on <a> is ignored',
    ]);
  });

  test("names from Object.prototype are plain attributes", () => {
    // A computed key creates an own "__proto__" property, as JSON.parse does.
    assert.deepEqual(children(`<div __proto__="x" constructor="y" tostring="z"></div>`), [
      el("div", { ["__proto__"]: "x", constructor: "y", tostring: "z" }),
    ]);
  });
});

/* ---------- Text and whitespace ---------- */

describe("text and whitespace", () => {
  test("text is not trimmed", () => {
    assert.deepEqual(children("<p>  a  </p>"), [el("p", text("  a  "))]);
  });

  test("indentation between tags is dropped", () => {
    assert.deepEqual(children("<ul>\n  <li>a</li>\n  <li>b</li>\n</ul>\n"), [
      el("ul", el("li", text("a")), el("li", text("b"))),
    ]);
  });

  test("a space between inline elements is kept", () => {
    assert.deepEqual(children("<b>Hello</b> <i>world</i>"), [el("b", text("Hello")), text(" "), el("i", text("world"))]);
  });

  test("whitespace written as references is kept", () => {
    assert.deepEqual(children("<div>&#10;</div><div>&nbsp;</div>"), [el("div", text("\n")), el("div", text(" "))]);
  });

  test("pre and textarea keep whitespace, without the first line break", () => {
    assert.deepEqual(children("<pre>\n  a\n\n</pre><textarea>\n\n b</textarea><pre><b>\n</b></pre>"), [
      el("pre", text("  a\n\n")),
      el("textarea", text("\n b")),
      el("pre", el("b", text("\n"))),
    ]);
  });

  test("< that does not start a tag is text", () => {
    assert.deepEqual(children("<p>a < b, 1<2, <3, < div</p>"), [el("p", text("a < b, 1<2, <3, < div"))]);
  });

  test("adjacent text is merged", () => {
    assert.deepEqual(children("a</span>b</>c"), [text("abc")]);
  });

  test("text left before an omitted end tag is kept, as in browsers", () => {
    assert.deepEqual(children("<ul>\n  <li>one\n  <li>two\n</ul>"), [el("ul", el("li", text("one\n  ")), el("li", text("two\n")))]);
  });
});

/* ---------- Character references ---------- */

describe("character references", () => {
  test("named references", () => {
    assert.deepEqual(children("&amp;&lt;&gt;&quot;&apos;&copy;&nbsp;&mdash;&AMP;"), [text("&<>\"'© —&")]);
  });

  test("names are case-sensitive, unknown names are kept", () => {
    assert.deepEqual(children("&Amp; &foo; &notit; &constructor; &__proto__;"), [
      text("&Amp; &foo; &notit; &constructor; &__proto__;"),
    ]);
  });

  test("numeric references, with and without ;", () => {
    assert.deepEqual(children("&#169;&#xA9;&#XA9;&#169 &#60;b&#62;"), [text("©©©© <b>")]);
  });

  test("invalid numbers become U+FFFD with a warning", () => {
    const html = "&#0;&#99999999999;&#xD800;&#x110000;";
    assert.deepEqual(children(html), [text("����")]);
    assert.equal(warnings(html).length, 4);
  });

  test("a very long number does not overflow", () => {
    const result = parse(`&#${"9".repeat(100000)};x`);
    assert.deepEqual(result.children, [text("�x")]);
    assert.ok(result.warnings[0].message.length < 100, "the warning quotes the whole number");
  });

  test("0x80-0x9F are read as Windows-1252", () => {
    assert.deepEqual(children("&#128;&#150;&#x9F;"), [text("€–Ÿ")]);
  });

  test("broken references are kept", () => {
    assert.deepEqual(children("&#; &#x; &#xG; & a&b &;"), [text("&#; &#x; &#xG; & a&b &;")]);
  });

  test("legacy names without ; in text", () => {
    assert.deepEqual(children("&copy 2024 &amp done &copyright &hellip x"), [text("© 2024 & done ©right &hellip x")]);
  });

  test("legacy names without ; in attributes are kept before = or alphanumerics", () => {
    assert.deepEqual(children(`<a href="?a=1&copy=2&amp;b=3&copy x&reg2" title=&lt;b&gt;>`), [
      el("a", { href: "?a=1&copy=2&b=3© x&reg2", title: "<b>" }),
    ]);
  });

  test("not decoded in comments, doctype and attribute names", () => {
    assert.deepEqual(children("<!-- &amp; --><!DOCTYPE &amp;><i a&amp;=1></i>"), [
      comment(" &amp; "),
      doctype("&amp;"),
      el("i", { "a&amp;": "1" }),
    ]);
  });
});

/* ---------- Raw text ---------- */

describe("raw text elements", () => {
  test("script and style are kept as written", () => {
    assert.deepEqual(children(`<script>if (a<b) x = "<p>&amp;";</script><style>a > b {}</style>`), [
      el("script", text(`if (a<b) x = "<p>&amp;";`)),
      el("style", text("a > b {}")),
    ]);
  });

  test("textarea and title have no tags but decode references", () => {
    assert.deepEqual(children("<textarea><b>x</b> &amp;</textarea><title>A &amp; <i>B</i></title>"), [
      el("textarea", text("<b>x</b> &")),
      el("title", text("A & <i>B</i>")),
    ]);
  });

  test("end tag is case-insensitive and needs a delimiter after the name", () => {
    assert.deepEqual(children("<script>a</scripts>b</SCRIPT >c"), [el("script", text("a</scripts>b")), text("c")]);
  });

  test("</script> inside a JS string ends the script, as in browsers", () => {
    const html = `<script>var s = "</script>";</script>`;
    assert.deepEqual(children(html), [el("script", text('var s = "')), text('";')]);
    assert.deepEqual(warnings(html), ["1:29 Unexpected end tag </script> is ignored"]);
  });

  test("<script/> is closed", () => {
    assert.deepEqual(children("<script/><p>x</p>"), [el("script"), el("p", text("x"))]);
  });

  test("unclosed script runs to the end of input", () => {
    const html = '<script>var a = "<p>";';
    assert.deepEqual(children(html), [el("script", text('var a = "<p>";'))]);
    assert.deepEqual(warnings(html), ["1:1 Element <script> is not closed before the end of input"]);
  });
});

/* ---------- Comments, doctype, bogus markup ---------- */

describe("comments and doctype", () => {
  test("doctype in any case", () => {
    assert.deepEqual(children("<!DOCTYPE html><!doctype HTML>"), [doctype("html"), doctype("HTML")]);
  });

  test("doctype with identifiers", () => {
    assert.deepEqual(children('<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0//EN" "x.dtd">'), [
      doctype('html PUBLIC "-//W3C//DTD XHTML 1.0//EN" "x.dtd"'),
    ]);
  });

  test("comment forms", () => {
    assert.deepEqual(children("<!-- a --><!----><!--><!---><!-- b ---><!-- c --!><!-- <p>x</p> -- y -->"), [
      comment(" a "), comment(""), comment(""), comment(""), comment(" b -"), comment(" c "), comment(" <p>x</p> -- y "),
    ]);
  });

  test("unclosed comment runs to the end of input", () => {
    const html = "<p>x</p><!-- never <div>";
    assert.deepEqual(children(html), [el("p", text("x")), comment(" never <div>")]);
    assert.deepEqual(warnings(html), ["1:9 Comment is not closed before the end of input"]);
  });

  test("unknown markup becomes a comment with a warning", () => {
    const html = '<![CDATA[ a ]]><?xml version="1.0"?></ 3>';
    assert.deepEqual(children(html), [comment("[CDATA[ a ]]"), comment('?xml version="1.0"?'), comment(" 3")]);
    assert.deepEqual(warnings(html), [
      '1:1 "<!" markup is treated as a comment',
      '1:16 "<?" markup is treated as a comment',
      "1:37 Invalid end tag is treated as a comment",
    ]);
  });

  test("</> is ignored, </ at the end is text", () => {
    assert.deepEqual(children("a</>b</"), [text("ab</")]);
    assert.deepEqual(warnings("a</>b"), ['1:2 Empty end tag "</>" is ignored']);
  });
});

/* ---------- Implicit closing ---------- */

describe("implicit closing", () => {
  test("p is closed by p and block elements, without warnings", () => {
    const html = "<p>a<p>b<div>c</div><p>d<ul><li>e</ul>";
    assert.deepEqual(children(html), [
      el("p", text("a")), el("p", text("b")), el("div", text("c")), el("p", text("d")), el("ul", el("li", text("e"))),
    ]);
    assert.deepEqual(warnings(html), []);
  });

  test("li closes li, but not across a nested list", () => {
    assert.deepEqual(children("<ul><li>a<li>b<ul><li>c<li>d</ul><li>e</ul>"), [
      el("ul",
        el("li", text("a")),
        el("li", text("b"), el("ul", el("li", text("c")), el("li", text("d")))),
        el("li", text("e"))),
    ]);
  });

  test("table rows and cells", () => {
    assert.deepEqual(children("<table><tr><td>1<td>2<tr><th>a<th>b</table>"), [
      el("table",
        el("tr", el("td", text("1")), el("td", text("2"))),
        el("tr", el("th", text("a")), el("th", text("b")))),
    ]);
  });

  test("options, dt and dd", () => {
    assert.deepEqual(children("<select><option>A<option>B</select><dl><dt>t<dd>d<dt>u</dl>"), [
      el("select", el("option", text("A")), el("option", text("B"))),
      el("dl", el("dt", text("t")), el("dd", text("d")), el("dt", text("u"))),
    ]);
  });

  test("li closes the p inside it first", () => {
    assert.deepEqual(children("<ul><li><p>a<li>b</ul>"), [el("ul", el("li", el("p", text("a"))), el("li", text("b")))]);
  });
});

/* ---------- Invalid HTML ---------- */

describe("invalid HTML", () => {
  test("misnested tags", () => {
    const html = "<b><i>x</b></i>";
    assert.deepEqual(children(html), [el("b", el("i", text("x")))]);
    assert.deepEqual(warnings(html), [
      "1:4 Element <i> is closed by </b> before its own end tag",
      "1:12 Unexpected end tag </i> is ignored",
    ]);
  });

  test("stray end tags are ignored", () => {
    const html = "</div><p>x</p></span>";
    assert.deepEqual(children(html), [el("p", text("x"))]);
    assert.deepEqual(warnings(html), ["1:1 Unexpected end tag </div> is ignored", "1:15 Unexpected end tag </span> is ignored"]);
  });

  test("elements open at the end of input are closed", () => {
    const html = "<div><span>x";
    assert.deepEqual(children(html), [el("div", el("span", text("x")))]);
    assert.deepEqual(warnings(html), [
      "1:1 Element <div> is not closed before the end of input",
      "1:6 Element <span> is not closed before the end of input",
    ]);
  });

  test("tag cut off by the end of input is kept", () => {
    const html = '<p>x</p><div class="a';
    assert.deepEqual(children(html), [el("p", text("x")), el("div", { class: "a" })]);
    assert.deepEqual(warnings(html), ["1:9 Tag <div> is cut off by the end of input", '1:20 Unclosed quote in attribute "class"']);
  });

  test("unclosed quote runs to the next matching quote", () => {
    // The value of class ends at the quote before b, so the next name is 'b"', as in browsers.
    assert.deepEqual(children(`<div class="a>text</div><p title="b">`), [el("div", { class: "a>text</div><p title=", 'b"': "" })]);
  });

  test("end tag with attributes", () => {
    assert.deepEqual(warnings(`<p>x</p class="y">`), ["1:5 End tag </p> has attributes, they are ignored"]);
  });

  test("< and </ at the end of input", () => {
    assert.deepEqual(children("<p>x</p><"), [el("p", text("x")), text("<")]);
    assert.deepEqual(children("<p>x</p></"), [el("p", text("x")), text("</")]);
  });
});

/* ---------- SVG and MathML ---------- */

describe("svg and math", () => {
  test("case is kept inside svg, HTML again inside foreignObject", () => {
    assert.deepEqual(children('<svg viewBox="0 0 1 1"><linearGradient gradientUnits="u"/><foreignObject><DIV ID="x"></DIV></foreignObject></svg>'), [
      el("svg", { viewBox: "0 0 1 1" },
        el("linearGradient", { gradientUnits: "u" }),
        el("foreignObject", el("div", { id: "x" }))),
    ]);
  });

  test("case is lowercased outside svg", () => {
    assert.deepEqual(children('<DIV ViewBox="1"></DIV>'), [el("div", { viewbox: "1" })]);
  });

  test("math", () => {
    assert.deepEqual(children("<math><mi>x</mi><mo>=</mo></math>"), [el("math", el("mi", text("x")), el("mo", text("=")))]);
  });
});

/* ---------- Warning positions ---------- */

describe("warning positions", () => {
  test("line and column on later lines", () => {
    assert.deepEqual(warnings("<div>\n  <p>x</span>"), [
      "1:1 Element <div> is not closed before the end of input",
      "2:7 Unexpected end tag </span> is ignored",
    ]);
  });

  test("\\r\\n and \\r count as one line break", () => {
    assert.deepEqual(warnings("a\r\nb\rc\n</x>"), ["4:1 Unexpected end tag </x> is ignored"]);
  });

  test("BOM is not counted", () => {
    assert.deepEqual(warnings("﻿</x>"), ["1:1 Unexpected end tag </x> is ignored"]);
  });

  test("warnings are sorted by position", () => {
    // The tokenizer and the tree builder report in different order.
    assert.deepEqual(warnings("</a>&#0;</b>"), [
      "1:1 Unexpected end tag </a> is ignored",
      '1:5 Invalid character reference "&#0;" is replaced with U+FFFD',
      "1:9 Unexpected end tag </b> is ignored",
    ]);
  });
});

/* ---------- Depth limit ---------- */

describe("depth limit", () => {
  test("10000 nested elements are flattened and serializable", () => {
    const n = 10000;
    const result = html2json("<div>".repeat(n) + "deep" + "</div>".repeat(n));
    assert.doesNotThrow(() => JSON.stringify(result));
    assertValidTree(JSON.parse(JSON.stringify(result)));
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0].message, /^Nesting deeper than 512 levels is flattened/);
  });

  test("512 levels are kept as written", () => {
    const result = parse("<i>".repeat(512) + "x");
    let node = result;
    for (let depth = 0; depth < 512; depth++) node = node.children[0];
    assert.equal(node.tag, "i");
    assert.deepEqual(node.children, [text("x")]);
    assert.equal(result.warnings.length, 512, "only the 512 unclosed <i> warnings");
  });

  test("the 513th level is added as a sibling", () => {
    const result = parse("<i>".repeat(512) + "<b>x</b>y");
    let node = result;
    for (let depth = 0; depth < 512; depth++) node = node.children[0];
    assert.deepEqual(node.children, [el("b"), text("xy")]);
    assert.ok(result.warnings.some((w) => w.message.startsWith("Nesting deeper than 512")));
    assert.ok(!result.warnings.some((w) => w.message.includes("</b>")), "</b> of the flattened element is not unexpected");
  });
});

/* ---------- Samples ---------- */

describe("html_samples", () => {
  for (const file of fs.readdirSync(SAMPLES_DIR).sort()) {
    test(file, () => {
      const html = fs.readFileSync(path.join(SAMPLES_DIR, file), "utf8");
      const result = html2json(html);
      assertValidTree(JSON.parse(JSON.stringify(result)));
    });
  }
});

/* ---------- Robustness ---------- */

// Small deterministic random generator (mulberry32), so a failing input can be reproduced.
function createRandom(seed) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FUZZ_PIECES = [
  "<", ">", "/", "</", "/>", "<!", "<!--", "-->", "--", "<?", "!", "=", '"', "'", "&", "&#", "&#x", ";",
  " ", "\n", "\r\n", "\t", "a", "x", "1", "9999999", "amp", "copy", "nbsp", "﻿", "😀", "\u0000",
  "div", "p", "li", "ul", "table", "tr", "td", "b", "i", "br", "img", "pre", "textarea", "script", "style",
  "title", "svg", "math", "foreignObject", "DOCTYPE", "[CDATA[", "class", "__proto__", "constructor",
];

describe("robustness", () => {
  test("5000 random HTML-like inputs do not throw", () => {
    const random = createRandom(20261101);
    for (let i = 0; i < 5000; i++) {
      const length = Math.floor(random() * 60);
      let html = "";
      for (let j = 0; j < length; j++) html += FUZZ_PIECES[Math.floor(random() * FUZZ_PIECES.length)];
      try {
        assertValidTree(JSON.parse(JSON.stringify(html2json(html))));
      } catch (error) {
        error.message = `input ${JSON.stringify(html)}: ${error.message}`;
        throw error;
      }
    }
  });

  // Inputs that would take quadratic time in a parser that rescans the input.
  const pathological = {
    "a million &": "&".repeat(1e6),
    "a million <": "<".repeat(1e6),
    "half a million &#": "&#".repeat(5e5),
    "half a million <!": "<!".repeat(5e5),
    "unclosed comment with many dashes": "<!--" + "-a".repeat(5e5),
    "100000 stray end tags on a deep stack": "<div>".repeat(600) + "</span>".repeat(1e5),
    "one tag with 200000 attributes": "<a" + " b".repeat(2e5) + ">",
    "100000 unclosed li": "<ul>" + "<li>x".repeat(1e5),
    "script with many </ candidates": "<script>" + "</scrip".repeat(2e5),
  };
  for (const [name, html] of Object.entries(pathological)) {
    test(`fast on ${name}`, () => {
      const start = performance.now();
      const result = html2json(html);
      const elapsed = performance.now() - start;
      assertValidTree(JSON.parse(JSON.stringify(result)));
      assert.ok(elapsed < 2000, `took ${elapsed.toFixed(0)} ms`);
    });
  }
});
