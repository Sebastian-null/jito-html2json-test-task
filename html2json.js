function convertHtml2JsonAndSet() {
  const htmlTextAreaValue = document.getElementById("html").value;
  const jsonObj = html2json(htmlTextAreaValue);
  const jsonArea = document.getElementById("json");
  jsonArea.textContent = JSON.stringify(jsonObj, null, 2);
}

/* 
  Update this function to convert html into json object.
  You can rewrite it completely, just be sure it accepts htmlText as string and outputs json object.
*/
function html2json(htmlText) {
  return {
    "Conversion results": "should be instead of this json obj",
    "Just to show that it is dynamic value (input length)" : htmlText.length,
  };
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
    { type: "text",     content, start, end }
    { type: "comment",  content, start, end }
    { type: "doctype",  content, start, end }
  Character references in text and attribute values are decoded, except in
  <script> and <style>. `start` and `end` are offsets in the input. Problems
  found in the input are added to `warnings` as { message, offset }.
*/
function tokenize(input, warnings = []) {
  const tokens = [];
  let pos = 0;
  let textStart = 0;

  function pushText(end, decode) {
    if (end <= textStart) return;
    const raw = input.slice(textStart, end);
    const content = decode ? decodeCharacterReferences(raw, false, textStart, warnings) : raw;
    tokens.push({ type: "text", content, start: textStart, end });
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
    // Capped, so a very long number cannot grow past the valid range.
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
  module.exports = { html2json, tokenize };
}
