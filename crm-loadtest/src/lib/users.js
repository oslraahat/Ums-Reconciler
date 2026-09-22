"use strict";
/* the users file: one "username,password" per line → [{ user, pass, line }] */
const fs = require("fs");

function readUsers(file) {
  const raw = fs.readFileSync(file, "utf8");
  const out = [];
  raw.split(/\r?\n/).forEach(function (line, i) {
    const s = line.trim();
    if (!s || s.startsWith("#")) return;
    /* comma or tab first; otherwise the FIRST space — the username has no spaces, the password
       may, so everything after the first space is the password */
    let user, pass;
    if (s.indexOf(",") >= 0) { const p = s.split(","); user = p[0]; pass = p.slice(1).join(","); }
    else if (s.indexOf("\t") >= 0) { const p = s.split("\t"); user = p[0]; pass = p.slice(1).join("\t"); }
    else { const at = s.indexOf(" "); if (at < 0) { user = s; pass = ""; } else { user = s.slice(0, at); pass = s.slice(at + 1); } }
    user = user.trim(); pass = pass.trim();
    // a column-name header, in any capitalisation ("User Name", "Login", "Pwd" …) — not a login
    if (i === 0 && /^(user\s*(name|id)?|login|email)$/i.test(user) && /^(pass\s*(word)?|pwd)$/i.test(pass)) return;
    if (user) out.push({ user: user, pass: pass, line: i + 1 });
  });
  return out;
}

module.exports = { readUsers: readUsers };
