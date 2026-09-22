"use strict";
/* ---------------- one user: log in ---------------- */
/* The login form is the one thing this tool cannot know in advance, so it finds it rather than
   being told: go to the site, and if a password box is on the page, this is the login page. The
   password box is unambiguous; the username box is the visible text box just before it in the
   same form. Filling the site's real form means the browser sends the ASP.NET antiforgery token
   with it automatically — the thing that makes raw HTTP logins so fragile is simply not our
   problem here. Selectors can still be forced with --user-field / --pass-field. */
async function login(context, base, opts) {
  const page = await context.newPage();
  page.setDefaultTimeout(opts.navTimeout);
  const t0 = Date.now();

  /* Going straight to the Dashboard is the honest path: a logged-out user is redirected to the
     login page by the site itself, which is also how we will confirm success later. */
  const target = base + opts.dash;
  await page.goto(target, { waitUntil: "domcontentloaded" });

  const passSel = opts.passField || 'input[type="password"]';
  const hasPass = await page.$(passSel);
  if (!hasPass) {
    /* No password box and not sent to the login page → already usable, or an unexpected page. */
    const onLogin = /Account\/Login/i.test(page.url());
    if (!onLogin) return { page: page, ok: true, note: "no login needed", ms: Date.now() - t0 };
    /* On the login page but the selector missed — try the configured login path explicitly. */
    await page.goto(base + opts.login, { waitUntil: "domcontentloaded" });
  }

  const pass = await page.$(passSel);
  if (!pass) { await page.close(); return { ok: false, why: "no password field found — pass --pass-field" }; }

  let userSel = opts.userField;
  if (!userSel) {
    /* the visible, non-hidden text-ish input that comes before the password box */
    userSel = await page.evaluate(function (ps) {
      const pw = document.querySelector(ps);
      const inputs = Array.prototype.slice.call(document.querySelectorAll("input"));
      const before = inputs.slice(0, inputs.indexOf(pw));
      const cand = before.reverse().find(function (el) {
        const ty = (el.type || "text").toLowerCase();
        if (["hidden", "checkbox", "radio", "submit", "button"].indexOf(ty) >= 0) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      if (!cand) return null;
      if (cand.id) return "#" + CSS.escape(cand.id);
      if (cand.name) return 'input[name="' + cand.name.replace(/"/g, '\\"') + '"]';
      return null;
    }, passSel);
  }
  if (!userSel) { await page.close(); return { ok: false, why: "no username field found — pass --user-field" }; }

  await page.fill(userSel, opts.__user);
  await page.fill(passSel, opts.__pass);

  /* submit and wait for the page to settle wherever it lands */
  await Promise.all([
    page.waitForLoadState("domcontentloaded"),
    (async function () {
      const btn = await page.$('button[type="submit"], input[type="submit"], button:not([type])');
      if (btn) await btn.click(); else await page.press(passSel, "Enter");
    })()
  ]).catch(function () {});
  /* a moment for a redirect that the click did not wait out */
  await page.waitForTimeout(400);

  const stillLogin = /Account\/Login/i.test(page.url()) || !!(await page.$(passSel));
  if (stillLogin) {
    const msg = (await page.evaluate(function () {
      const e = document.querySelector(".validation-summary-errors, .text-danger, .alert-danger, [role=alert]");
      return e ? e.textContent.replace(/\s+/g, " ").trim().slice(0, 80) : "";
    })) || "still on the login page";
    await page.close();
    return { ok: false, why: msg };
  }
  return { page: page, ok: true, ms: Date.now() - t0 };
}

module.exports = { login: login };
