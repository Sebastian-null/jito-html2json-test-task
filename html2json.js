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
  `start` and `end` are offsets in the input. Problems found in the input are
  added to `warnings` as { message, offset }.
*/
function tokenize(input, warnings = []) {
  const tokens = [];
  let pos = 0;
  let textStart = 0;

  function pushText(end) {
    if (end > textStart) {
      tokens.push({ type: "text", content: input.slice(textStart, end), start: textStart, end });
    }
  }

  while (pos < input.length) {
    const lt = input.indexOf("<", pos);
    if (lt === -1) break;

    const token = readMarkup(input, lt, warnings);
    if (token === null) {
      pos = lt + 1;
      continue;
    }

    pushText(lt);
    if (token.type !== "ignored") tokens.push(token);
    pos = token.end;

    if (token.type === "startTag" && !token.selfClosing) {
      const name = token.name.toLowerCase();
      if (RAW_TEXT_TAGS.has(name)) {
        textStart = pos;
        pos = findRawTextEnd(input, pos, name);
        pushText(pos);
      }
    }
    textStart = pos;
  }

  pushText(input.length);
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
    value = input.slice(pos + 1, valueEnd);
    pos = close === -1 ? valueEnd : close + 1;
  } else {
    // Unquoted: ends at whitespace or ">". A "/" is part of the value (href=/a/).
    const valueStart = pos;
    while (pos < input.length && !isAsciiWhitespace(input[pos]) && input[pos] !== ">") pos++;
    value = input.slice(valueStart, pos);
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
