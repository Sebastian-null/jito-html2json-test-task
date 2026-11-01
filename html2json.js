function convertHtml2JsonAndSet() {
  const htmlTextAreaValue = document.getElementById("html").value;
  const jsonArea = document.getElementById("json");
  // html2json is designed not to throw, but the page should still show
  // something if it does (a bug, or JSON.stringify running out of memory).
  try {
    const jsonObj = html2json(htmlTextAreaValue);
    jsonArea.textContent = JSON.stringify(jsonObj, null, 2);
  } catch (error) {
    console.error(error);
    jsonArea.textContent = `Conversion failed: ${error}`;
  }
}

/*
  Converts an HTML string into a JSON tree:
    { type: "root", children: [...], warnings: [{ message, line, column }] }
  Never throws: problems in the input are reported in `warnings`.
  See README.md for the format and the design decisions.
*/
function html2json(htmlText) {
  if (typeof htmlText !== "string") {
    const received = htmlText === null ? "null" : typeof htmlText;
    return {
      type: "root",
      children: [],
      warnings: [{ message: `Expected a string, got ${received}`, line: 1, column: 1 }],
    };
  }

  const input = normalizeInput(htmlText);
  const warnings = [];
  const builder = new TreeBuilder(warnings);
  for (const token of tokenize(input, warnings)) builder.add(token);

  const root = builder.finish();
  root.warnings = locateWarnings(input, warnings);
  return root;
}

/*
  Turns { message, offset } into { message, line, column }, sorted by position.
  Line starts are collected once, then each offset is found by binary search.
*/
function locateWarnings(input, warnings) {
  if (warnings.length === 0) return [];

  const lineStarts = [0];
  for (let i = input.indexOf("\n"); i !== -1; i = input.indexOf("\n", i + 1)) lineStarts.push(i + 1);

  return warnings
    .slice()
    .sort((a, b) => a.offset - b.offset)
    .map(({ message, offset }) => {
      const lineIndex = findLineIndex(lineStarts, offset);
      return { message, line: lineIndex + 1, column: offset - lineStarts[lineIndex] + 1 };
    });
}

// Index of the last line start that is <= offset.
function findLineIndex(lineStarts, offset) {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (lineStarts[middle] <= offset) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
}

/* ---------- Tokenizer ---------- */

// No tags inside: everything up to the matching end tag is text.
const RAW_TEXT_TAGS = new Set(["script", "style", "textarea", "title"]);
// Of those, character references are decoded only here, as in browsers.
const DECODED_RAW_TEXT_TAGS = new Set(["textarea", "title"]);

function isAsciiWhitespace(ch) {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f";
}

function isAsciiLetter(ch) {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z");
}

function skipWhitespace(input, pos) {
  while (pos < input.length && isAsciiWhitespace(input[pos])) pos++;
  return pos;
}

function trimAsciiWhitespace(text) {
  let start = 0;
  let end = text.length;
  while (start < end && isAsciiWhitespace(text[start])) start++;
  while (end > start && isAsciiWhitespace(text[end - 1])) end--;
  return text.slice(start, end);
}

// True for text of only ASCII whitespace with a line break: indentation between tags.
function isFormattingWhitespace(text) {
  let hasLineBreak = false;
  for (let i = 0; i < text.length; i++) {
    if (!isAsciiWhitespace(text[i])) return false;
    if (text[i] === "\n") hasLineBreak = true;
  }
  return hasLineBreak;
}

// Input preprocessing from the HTML spec: drop a leading BOM,
// turn "\r\n" and a lone "\r" into "\n".
function normalizeInput(input) {
  const withoutBom = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  return withoutBom.replace(/\r\n?/g, "\n");
}

/*
  Splits the input into a flat list of tokens in a single forward pass:
    { type: "startTag", name, attributes, selfClosing, terminated, start, end }
    { type: "endTag",   name, attributes, selfClosing, terminated, start, end }
    { type: "text",     content, formattingWhitespace, start, end }
    { type: "comment",  content, start, end }
    { type: "doctype",  content, start, end }
  Character references in text and attribute values are decoded, except in
  <script> and <style>. `start` and `end` are offsets in the input. Problems
  found in the input are added to `warnings` as { message, offset }.
*/
function tokenize(input, warnings) {
  const tokens = [];
  let pos = 0;
  let textStart = 0;

  function pushText(end, decode) {
    if (end <= textStart) return;
    const raw = input.slice(textStart, end);
    tokens.push({
      type: "text",
      content: decode ? decodeCharacterReferences(raw, false, textStart, warnings) : raw,
      // Checked before decoding, so "&#10;" written on purpose is not taken for indentation.
      formattingWhitespace: isFormattingWhitespace(raw),
      start: textStart,
      end,
    });
  }

  while (pos < input.length) {
    const lt = input.indexOf("<", pos);
    if (lt === -1) break;

    const token = readMarkup(input, lt, warnings);
    if (token === null) {
      pos = lt + 1;
      continue;
    }

    pushText(lt, true);
    if (token.type !== "ignored") tokens.push(token);
    pos = token.end;

    if (token.type === "startTag" && !token.selfClosing) {
      const name = token.name.toLowerCase();
      if (RAW_TEXT_TAGS.has(name)) {
        textStart = pos;
        pos = findRawTextEnd(input, pos, name);
        pushText(pos, DECODED_RAW_TEXT_TAGS.has(name));
      }
    }
    textStart = pos;
  }

  pushText(input.length, true);
  return tokens;
}

/*
  Decides what starts at the "<" and reads it. Returns null if the "<" is plain
  text ("a < b", "<3", "</" at the end of input). For "</>", which browsers drop,
  returns a token of type "ignored" so the caller can skip it.
*/
function readMarkup(input, pos, warnings) {
  const next = input[pos + 1];
  if (isAsciiLetter(next)) return readTag(input, pos, warnings);
  if (next === "!") return readMarkupDeclaration(input, pos, warnings);
  if (next === "?") {
    return readBogusComment(input, pos, pos + 1, `"<?" markup is treated as a comment`, warnings);
  }
  if (next !== "/") return null;

  const afterSlash = input[pos + 2];
  if (isAsciiLetter(afterSlash)) return readTag(input, pos, warnings);
  if (afterSlash === ">") {
    warnings.push({ message: `Empty end tag "</>" is ignored`, offset: pos });
    return { type: "ignored", start: pos, end: pos + 3 };
  }
  if (afterSlash === undefined) return null;
  return readBogusComment(input, pos, pos + 2, "Invalid end tag is treated as a comment", warnings);
}

// Reads "<name ...>" or "</name ...>" starting at the "<".
// If the input ends inside the tag, the tag is kept with terminated: false.
function readTag(input, start, warnings) {
  const isEndTag = input[start + 1] === "/";
  let pos = start + (isEndTag ? 2 : 1);

  const nameStart = pos;
  while (pos < input.length && !isTagNameEnd(input[pos])) pos++;
  const name = input.slice(nameStart, pos);

  const attributes = [];
  let selfClosing = false;
  let terminated = false;

  while (pos < input.length) {
    const ch = input[pos];
    if (isAsciiWhitespace(ch)) {
      pos++;
    } else if (ch === ">") {
      pos++;
      terminated = true;
      break;
    } else if (ch === "/") {
      pos++;
      if (input[pos] === ">") {
        pos++;
        selfClosing = true;
        terminated = true;
        break;
      }
      // A "/" not followed by ">" is ignored, as in browsers.
    } else {
      pos = readAttribute(input, pos, attributes, warnings);
    }
  }

  if (!terminated) {
    const tagText = (isEndTag ? "</" : "<") + name;
    warnings.push({ message: `Tag ${tagText}> is cut off by the end of input`, offset: start });
  }

  return {
    type: isEndTag ? "endTag" : "startTag",
    name,
    attributes,
    selfClosing,
    terminated,
    start,
    end: pos,
  };
}

function isTagNameEnd(ch) {
  return isAsciiWhitespace(ch) || ch === "/" || ch === ">";
}

// Reads what starts with "<!": a comment, a doctype or a bogus comment.
function readMarkupDeclaration(input, start, warnings) {
  if (input.startsWith("--", start + 2)) return readComment(input, start, warnings);
  if (input.slice(start + 2, start + 9).toLowerCase() === "doctype") {
    return readDoctype(input, start, warnings);
  }
  return readBogusComment(input, start, start + 2, `"<!" markup is treated as a comment`, warnings);
}

/*
  Reads "<!-- ... -->". As in browsers, "--!>" also closes a comment, and
  "<!-->" and "<!--->" are empty comments. Only "--" is searched for, so the
  scan moves forward once even when "--!>" never appears in the input.
*/
function readComment(input, start, warnings) {
  const contentStart = start + 4;
  if (input[contentStart] === ">") return comment("", start, contentStart + 1);
  if (input.startsWith("->", contentStart)) return comment("", start, contentStart + 2);

  let dashes = input.indexOf("--", contentStart);
  while (dashes !== -1) {
    if (input[dashes + 2] === ">") {
      return comment(input.slice(contentStart, dashes), start, dashes + 3);
    }
    if (input.startsWith("!>", dashes + 2)) {
      return comment(input.slice(contentStart, dashes), start, dashes + 4);
    }
    dashes = input.indexOf("--", dashes + 1);
  }

  warnings.push({ message: "Comment is not closed before the end of input", offset: start });
  return comment(input.slice(contentStart), start, input.length);
}

// Reads "<!DOCTYPE ...>". `content` is the text after the keyword ("html").
function readDoctype(input, start, warnings) {
  const contentStart = start + "<!doctype".length;
  const close = input.indexOf(">", contentStart);
  if (close === -1) {
    warnings.push({ message: "Doctype is not closed before the end of input", offset: start });
  }
  const contentEnd = close === -1 ? input.length : close;
  return {
    type: "doctype",
    content: trimAsciiWhitespace(input.slice(contentStart, contentEnd)),
    start,
    end: close === -1 ? contentEnd : close + 1,
  };
}

/*
  Markup browsers do not understand ("<?xml ?>", "<![CDATA[ ]]>", "</ 3>")
  becomes a comment up to the first ">", as in browsers.
*/
function readBogusComment(input, start, contentStart, message, warnings) {
  warnings.push({ message, offset: start });
  const close = input.indexOf(">", contentStart);
  const contentEnd = close === -1 ? input.length : close;
  return comment(input.slice(contentStart, contentEnd), start, close === -1 ? contentEnd : close + 1);
}

function comment(content, start, end) {
  return { type: "comment", content, start, end };
}

// Reads one attribute (name, optional "=" and value), adds it to `attributes`
// and returns the position right after it.
function readAttribute(input, pos, attributes, warnings) {
  const nameStart = pos;
  // The first character always belongs to the name, even "=" (<div =a>).
  pos++;
  while (pos < input.length && !isAttributeNameEnd(input[pos])) pos++;
  const name = input.slice(nameStart, pos);

  pos = skipWhitespace(input, pos);
  if (input[pos] !== "=") {
    attributes.push({ name, value: "" });
    return pos;
  }

  pos = skipWhitespace(input, pos + 1);
  const quote = input[pos];
  let value;

  if (quote === '"' || quote === "'") {
    // Like in browsers, the value runs to the next matching quote, wherever it is.
    const close = input.indexOf(quote, pos + 1);
    if (close === -1) {
      warnings.push({ message: `Unclosed quote in attribute "${name}"`, offset: pos });
    }
    const valueEnd = close === -1 ? input.length : close;
    value = decodeCharacterReferences(input.slice(pos + 1, valueEnd), true, pos + 1, warnings);
    pos = close === -1 ? valueEnd : close + 1;
  } else {
    // Unquoted: ends at whitespace or ">". A "/" is part of the value (href=/a/).
    const valueStart = pos;
    while (pos < input.length && !isAsciiWhitespace(input[pos]) && input[pos] !== ">") pos++;
    value = decodeCharacterReferences(input.slice(valueStart, pos), true, valueStart, warnings);
  }

  attributes.push({ name, value });
  return pos;
}

function isAttributeNameEnd(ch) {
  return isAsciiWhitespace(ch) || ch === "/" || ch === ">" || ch === "=";
}

/*
  Finds where raw text of `tagName` ends: the first "</tagName" (case-insensitive)
  followed by whitespace, "/", ">" or the end of input. Like browsers, it does not
  look inside JS strings, so "</script>" in a script string also ends the script.
  Returns the input length if there is no end tag.
*/
function findRawTextEnd(input, pos, tagName) {
  let candidate = input.indexOf("</", pos);
  while (candidate !== -1) {
    const nameEnd = candidate + 2 + tagName.length;
    const after = input[nameEnd];
    const nameMatches = input.slice(candidate + 2, nameEnd).toLowerCase() === tagName;
    if (nameMatches && (after === undefined || isTagNameEnd(after))) return candidate;
    candidate = input.indexOf("</", candidate + 2);
  }
  return input.length;
}

/* ---------- Character references (entities) ---------- */

// The most common named references. The full HTML list has over 2000 names,
// any character can also be written as a number (&#8734;).
// A Map, not an object: with {} "&constructor;" would find Object.prototype.constructor.
const NAMED_REFERENCES = new Map([
  ["amp", "&"], ["lt", "<"], ["gt", ">"], ["quot", '"'], ["apos", "'"],
  ["AMP", "&"], ["LT", "<"], ["GT", ">"], ["QUOT", '"'],
  ["nbsp", " "], ["ensp", " "], ["emsp", " "], ["thinsp", " "], ["shy", "­"],
  ["copy", "©"], ["COPY", "©"], ["reg", "®"], ["REG", "®"], ["trade", "™"],
  ["deg", "°"], ["plusmn", "±"], ["times", "×"], ["divide", "÷"], ["minus", "−"],
  ["ne", "≠"], ["le", "≤"], ["ge", "≥"], ["infin", "∞"], ["micro", "µ"],
  ["frac14", "¼"], ["frac12", "½"], ["frac34", "¾"], ["sup1", "¹"], ["sup2", "²"], ["sup3", "³"],
  ["middot", "·"], ["bull", "•"], ["hellip", "…"], ["para", "¶"], ["sect", "§"],
  ["ndash", "–"], ["mdash", "—"], ["iexcl", "¡"], ["iquest", "¿"],
  ["laquo", "«"], ["raquo", "»"], ["lsquo", "‘"], ["rsquo", "’"], ["sbquo", "‚"],
  ["ldquo", "“"], ["rdquo", "”"], ["bdquo", "„"],
  ["cent", "¢"], ["pound", "£"], ["yen", "¥"], ["euro", "€"], ["curren", "¤"],
  ["larr", "←"], ["rarr", "→"], ["uarr", "↑"], ["darr", "↓"], ["harr", "↔"], ["hearts", "♥"],
]);

// Old names (from HTML 3.2) that browsers also decode without the ";" ("&copy 2024").
const LEGACY_NAMED_REFERENCES = new Set([
  "amp", "lt", "gt", "quot", "AMP", "LT", "GT", "QUOT", "nbsp", "shy",
  "copy", "COPY", "reg", "REG", "deg", "plusmn", "times", "divide", "micro",
  "frac14", "frac12", "frac34", "sup1", "sup2", "sup3", "middot", "para", "sect",
  "iexcl", "iquest", "laquo", "raquo", "cent", "pound", "yen", "curren",
]);
const LONGEST_LEGACY_NAME = Math.max(...[...LEGACY_NAMED_REFERENCES].map((name) => name.length));

// Browsers read &#128;-&#159; as Windows-1252 bytes, because old pages used them that way.
const WINDOWS_1252_REPLACEMENTS = new Map([
  [0x80, 0x20ac], [0x82, 0x201a], [0x83, 0x0192], [0x84, 0x201e], [0x85, 0x2026],
  [0x86, 0x2020], [0x87, 0x2021], [0x88, 0x02c6], [0x89, 0x2030], [0x8a, 0x0160],
  [0x8b, 0x2039], [0x8c, 0x0152], [0x8e, 0x017d], [0x91, 0x2018], [0x92, 0x2019],
  [0x93, 0x201c], [0x94, 0x201d], [0x95, 0x2022], [0x96, 0x2013], [0x97, 0x2014],
  [0x98, 0x02dc], [0x99, 0x2122], [0x9a, 0x0161], [0x9b, 0x203a], [0x9c, 0x0153],
  [0x9e, 0x017e], [0x9f, 0x0178],
]);

const MAX_CODE_POINT = 0x10ffff;

function isAsciiDigit(ch) {
  return ch >= "0" && ch <= "9";
}

function isAsciiHexDigit(ch) {
  return isAsciiDigit(ch) || (ch >= "a" && ch <= "f") || (ch >= "A" && ch <= "F");
}

function isAsciiAlphanumeric(ch) {
  return isAsciiLetter(ch) || isAsciiDigit(ch);
}

/*
  Replaces character references in `text`: "&amp;", "&#169;", "&#xA9;".
  Unknown or broken references are kept as written. `offset` is the position of
  `text` in the input, used for warnings. In attribute values a legacy name
  without ";" is not decoded before "=" or a letter/digit, so URLs like
  "?a=1&copy=2" stay intact.
*/
function decodeCharacterReferences(text, inAttribute, offset, warnings) {
  let amp = text.indexOf("&");
  if (amp === -1) return text;

  const parts = [];
  let copied = 0;
  while (amp !== -1) {
    const reference = text[amp + 1] === "#"
      ? readNumericReference(text, amp, offset, warnings)
      : readNamedReference(text, amp, inAttribute);

    if (reference === null) {
      amp = text.indexOf("&", amp + 1);
    } else {
      parts.push(text.slice(copied, amp), reference.value);
      copied = reference.end;
      amp = text.indexOf("&", copied);
    }
  }
  parts.push(text.slice(copied));
  return parts.join("");
}

// Reads "&#169;" or "&#xA9;" (the ";" is optional, as in browsers).
// Returns { value, end } or null if there are no digits ("&#;").
function readNumericReference(text, amp, offset, warnings) {
  let pos = amp + 2;
  const isHex = text[pos] === "x" || text[pos] === "X";
  if (isHex) pos++;

  const digitsStart = pos;
  let codePoint = 0;
  while (pos < text.length && (isHex ? isAsciiHexDigit(text[pos]) : isAsciiDigit(text[pos]))) {
    // Capped just above the valid range. Not required for correctness (a huge number
    // becomes Infinity, which is also > MAX_CODE_POINT), but keeps it a small integer.
    codePoint = Math.min(codePoint * (isHex ? 16 : 10) + parseInt(text[pos], 16), MAX_CODE_POINT + 1);
    pos++;
  }
  if (pos === digitsStart) return null;
  if (text[pos] === ";") pos++;

  return { value: codePointToString(codePoint, text.slice(amp, pos), offset + amp, warnings), end: pos };
}

/*
  Turns a number from a reference into a string, as browsers do: 0, values above
  U+10FFFF and surrogates become U+FFFD, and 0x80-0x9F use Windows-1252.
  String.fromCodePoint would throw on the out-of-range values.
*/
function codePointToString(codePoint, source, offset, warnings) {
  const isSurrogate = codePoint >= 0xd800 && codePoint <= 0xdfff;
  if (codePoint === 0 || codePoint > MAX_CODE_POINT || isSurrogate) {
    const shown = source.length > 20 ? `${source.slice(0, 20)}...` : source;
    warnings.push({ message: `Invalid character reference "${shown}" is replaced with U+FFFD`, offset });
    return "�";
  }
  if (WINDOWS_1252_REPLACEMENTS.has(codePoint)) {
    return String.fromCodePoint(WINDOWS_1252_REPLACEMENTS.get(codePoint));
  }
  return String.fromCodePoint(codePoint);
}

/*
  Reads "&name;". Without ";" only legacy names are decoded, and the longest
  legacy prefix wins, as in browsers ("&copyright" -> "©right").
  Unknown "&name;" is not decoded: guessing a prefix there could be wrong.
  Returns { value, end } or null.
*/
function readNamedReference(text, amp, inAttribute) {
  let pos = amp + 1;
  while (pos < text.length && isAsciiAlphanumeric(text[pos])) pos++;
  const name = text.slice(amp + 1, pos);
  if (name === "") return null;

  if (text[pos] === ";") {
    return NAMED_REFERENCES.has(name) ? { value: NAMED_REFERENCES.get(name), end: pos + 1 } : null;
  }

  for (let length = Math.min(name.length, LONGEST_LEGACY_NAME); length >= 2; length--) {
    const prefix = name.slice(0, length);
    if (!LEGACY_NAMED_REFERENCES.has(prefix)) continue;

    const end = amp + 1 + length;
    const next = text[end];
    if (inAttribute && (next === "=" || isAsciiAlphanumeric(next))) return null;
    return { value: NAMED_REFERENCES.get(prefix), end };
  }
  return null;
}

/* ---------- Tree builder ---------- */

const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr",
]);

// A start tag of these closes a <p> that is the current element: <p>text<div>.
const CLOSES_P = new Set([
  "address", "article", "aside", "blockquote", "dd", "details", "dialog", "div", "dl", "dt",
  "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6",
  "header", "hgroup", "hr", "li", "main", "menu", "nav", "ol", "p", "pre", "section", "table", "ul",
]);

// A start tag closes these while one of them is the current element: <li>a<li>b.
const IMPLICITLY_CLOSES = new Map([
  ["li", new Set(["li"])],
  ["dt", new Set(["dt", "dd"])],
  ["dd", new Set(["dt", "dd"])],
  ["option", new Set(["option"])],
  ["optgroup", new Set(["option", "optgroup"])],
  ["tr", new Set(["td", "th", "tr"])],
  ["td", new Set(["td", "th"])],
  ["th", new Set(["td", "th"])],
]);

// Their end tag may be left out in valid HTML, so closing them implicitly is not a warning.
const OPTIONAL_END_TAGS = new Set([
  "html", "head", "body", "p", "li", "dt", "dd", "option", "optgroup",
  "thead", "tbody", "tfoot", "tr", "td", "th", "colgroup", "caption", "rt", "rp",
]);

const PRESERVE_WHITESPACE = new Set(["pre", "textarea"]);

// JSON.stringify is recursive and throws on very deep trees (about 2800 levels in Node).
// Chrome's parser does not nest deeper than 512 either; deeper elements become siblings.
const MAX_DEPTH = 512;

/*
  Builds the tree from tokens with a stack of open elements, without recursion.
  The top of the stack is the current element: new nodes go into its children.
  Each stack entry keeps the node and what is needed while it is open:
  `name` (lowercased, for matching end tags), `namespace` ("html", "svg" or "math"),
  `preserveWhitespace`, and `cutOff` and `start` (for warnings).
*/
class TreeBuilder {
  constructor(warnings) {
    this.warnings = warnings;
    this.root = { type: "root", children: [] };
    this.stack = [{ node: this.root, name: "", namespace: "html", preserveWhitespace: false, cutOff: false, start: 0 }];
    // Elements past MAX_DEPTH that are not on the stack, by name, so their end tags are not "unexpected".
    this.flattenedOpen = new Map();
    this.depthWarned = false;
    // Browsers drop a line break right after <pre> and <textarea>.
    this.dropLeadingNewlineIn = null;
  }

  get current() {
    return this.stack[this.stack.length - 1];
  }

  add(token) {
    const dropLeadingNewlineIn = this.dropLeadingNewlineIn;
    this.dropLeadingNewlineIn = null;

    switch (token.type) {
      case "startTag":
        this.startTag(token);
        break;
      case "endTag":
        this.endTag(token);
        break;
      case "text":
        this.text(token, dropLeadingNewlineIn === this.current.node);
        break;
      case "comment":
      case "doctype":
        this.append({ type: token.type, content: token.content });
        break;
    }
  }

  finish() {
    while (this.stack.length > 1) {
      // A tag cut off by the end of input already has its own warning from the tokenizer.
      this.pop(this.current.cutOff ? undefined : "is not closed before the end of input");
    }
    return this.root;
  }

  startTag(token) {
    const name = token.name.toLowerCase();
    if (contextNamespace(this.current) === "html") this.closeImplicitly(name);

    const parent = this.current;
    const namespace = elementNamespace(parent, name);
    const isHtml = namespace === "html";
    const element = {
      type: "element",
      // SVG and MathML are case-sensitive (viewBox), so their names are kept as written.
      tag: isHtml ? name : token.name,
      attributes: this.collectAttributes(token, isHtml),
      children: [],
    };
    this.append(element);

    if (token.selfClosing || (isHtml && VOID_ELEMENTS.has(name))) return;
    if (this.stack.length > MAX_DEPTH) {
      this.flatten(name, token);
      return;
    }

    this.stack.push({
      node: element,
      name,
      namespace,
      preserveWhitespace: parent.preserveWhitespace || PRESERVE_WHITESPACE.has(name),
      cutOff: !token.terminated,
      start: token.start,
    });
    if (PRESERVE_WHITESPACE.has(name)) this.dropLeadingNewlineIn = element;
  }

  endTag(token) {
    const name = token.name.toLowerCase();
    if (token.attributes.length > 0) {
      this.warn(`End tag </${token.name}> has attributes, they are ignored`, token.start);
    }

    const flattened = this.flattenedOpen.get(name);
    if (flattened) {
      this.flattenedOpen.set(name, flattened - 1);
      return;
    }

    let index = this.stack.length - 1;
    while (index > 0 && this.stack[index].name !== name) index--;
    if (index === 0) {
      this.warn(`Unexpected end tag </${token.name}> is ignored`, token.start);
      return;
    }

    while (this.stack.length - 1 > index) this.pop(`is closed by </${token.name}> before its own end tag`);
    this.stack.pop();
  }

  text(token, dropLeadingNewline) {
    if (token.formattingWhitespace && !this.current.preserveWhitespace) return;

    let content = token.content;
    if (dropLeadingNewline && content[0] === "\n") content = content.slice(1);
    if (content === "") return;

    const children = this.current.node.children;
    const last = children[children.length - 1];
    if (last !== undefined && last.type === "text") {
      last.content += content;
    } else {
      children.push({ type: "text", content });
    }
  }

  // <p>a<div>, <li>a<li>b, <td>1<td>2: closes elements whose end tag the author left out.
  closeImplicitly(name) {
    if (CLOSES_P.has(name) && this.current.name === "p") this.pop();
    const closes = IMPLICITLY_CLOSES.get(name);
    while (closes !== undefined && closes.has(this.current.name)) this.pop();
  }

  // First attribute wins on duplicates. A prototype-less object keeps names like
  // "__proto__" and "constructor" as plain keys.
  collectAttributes(token, isHtml) {
    const attributes = Object.create(null);
    for (const { name, value } of token.attributes) {
      const key = isHtml ? name.toLowerCase() : name;
      if (key in attributes) {
        this.warn(`Duplicate attribute "${key}" on <${token.name}> is ignored`, token.start);
      } else {
        attributes[key] = value;
      }
    }
    return attributes;
  }

  flatten(name, token) {
    this.flattenedOpen.set(name, (this.flattenedOpen.get(name) || 0) + 1);
    if (!this.depthWarned) {
      this.depthWarned = true;
      const message = `Nesting deeper than ${MAX_DEPTH} levels is flattened: deeper elements are added as siblings`;
      this.warn(message, token.start);
    }
  }

  append(node) {
    this.current.node.children.push(node);
  }

  // Closes the current element. `reason` becomes a warning, unless the element's
  // end tag is optional (<p>, <li>, ...).
  pop(reason) {
    const frame = this.stack.pop();
    if (reason !== undefined && !OPTIONAL_END_TAGS.has(frame.name)) {
      this.warn(`Element <${frame.node.tag}> ${reason}`, frame.start);
    }
  }

  warn(message, offset) {
    this.warnings.push({ message, offset });
  }
}

// Namespace that children of `frame` start in. Inside <foreignObject> SVG hosts HTML again.
function contextNamespace(frame) {
  return frame.namespace === "svg" && frame.name === "foreignobject" ? "html" : frame.namespace;
}

function elementNamespace(parent, name) {
  const namespace = contextNamespace(parent);
  if (namespace !== "html") return namespace;
  if (name === "svg") return "svg";
  if (name === "math") return "math";
  return "html";
}

function showExample1() {
  const htmlExample = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport">
    <title>Sample HTML</title>
    <link rel="stylesheet" href="styles.css">
</head>
<body>
    <header>
        <h1>Welcome to My Website</h1>
    </header>
    <nav>
        <ul>
            <li><a href="#home">Home</a></li>
            <li><a href="#about">About</a></li>
            <li><a href="#contact">Contact</a></li>
        </ul>
    </nav>
    <main>
        <section id="home">
            <h2>Home Section</h2>
            <p>This is the home section of the webpage.</p>
        </section>
        <section id="about">
            <h2>About Section</h2>
            <p>This is the about section of the webpage.</p>
        </section>
    </main>
    <footer>
        <p>&copy; 2024 My Website</p>
    </footer>
    <script src="script.js"></script>
</body>
</html>
`;
  const jsonContent = {
    "Comment 1":
      "You have to think about how to take into account various html inputs so your json structure will cover them all and handle different cases.",
    "Comment 2":
      "When you make any choice in terms of selecting specific json structure for conversion - be ready to provide reasoning behind such choice.",
  };

  document.getElementById("html").value = htmlExample;
  document.getElementById("json").textContent = JSON.stringify(
    jsonContent,
    null,
    2
  );
}

function showExample2() {
  const htmlExample = `<div>
<p>Hello world!</p>
  <button>Click me!</button>
  <textarea>Some very very very very very very very very very very very very very very very very very very very very very very very very very very very very very very very very very very very long string.</textarea>
</div>
`;
  const jsonContent = {
    "Comment 1":
      "You have to think about how to take into account various html inputs so your json structure will cover them all and handle different cases.",
    "Comment 2":
      "When you make any choice in terms of selecting specific json structure for conversion - be ready to provide reasoning behind such choice.",
  };

  document.getElementById("html").value = htmlExample;
  document.getElementById("json").textContent = JSON.stringify(
    jsonContent,
    null,
    2
  );
}

// Allows running the parser in Node for tests; ignored in the browser.
if (typeof module !== "undefined") {
  module.exports = { html2json };
}
