"use strict";
/* select a course by cascading its batch-day → batch-time → batch dropdowns; returns whether the
   course actually had real batches at this branch (false → not enrollable here) */
async function configureCourse(page, courseId) {
  const el = await page.$(".course-name-check.course-" + courseId);
  if (!el) return false;
  const wasChecked = await el.evaluate(function (e) { return e.checked; });
  if (!wasChecked) await el.click({ timeout: 3000 }).catch(function () {});
  await page.waitForTimeout(300);

  await page.waitForFunction(
    function (id) { const s = document.querySelector(".batch-day-course-" + id); return s && s.options.length >= 1; },
    courseId, { timeout: 8000 }
  ).catch(function () {});

  const hasBatchDay = await page.evaluate(function (id) {
    const sel = document.querySelector(".batch-day-course-" + id);
    return sel ? [].slice.call(sel.options).some(function (o) { return o.value.trim(); }) : false;
  }, courseId);
  if (!hasBatchDay) {
    if (!wasChecked) await page.evaluate(function (id) {
      const cb = document.querySelector(".course-name-check.course-" + id); if (cb && cb.checked) cb.click();
    }, courseId).catch(function () {});
    return false;
  }

  const pickFirst = async function (cls) {
    const sel = "." + cls + "-course-" + courseId;
    await page.waitForFunction(
      function (s) { const el = document.querySelector(s); return el && el.options.length >= 1; },
      sel, { timeout: 8000 }
    ).catch(function () {});
    await page.evaluate(function (s) {
      const el = document.querySelector(s);
      if (!el) return;
      const opt = [].slice.call(el.options).find(function (o) { return o.value.trim(); });
      if (opt) { el.value = opt.value; el.dispatchEvent(new Event("change", { bubbles: true })); }
    }, sel);
    await page.waitForTimeout(700);
  };
  await pickFirst("batch-day");
  await pickFirst("batch-time");
  /* the batch select itself is class "batch-course-<id>" (no middle word) */
  await page.evaluate(function (id) {
    const sel = document.querySelector(".batch-course-" + id);
    if (!sel) return;
    const opt = [].slice.call(sel.options).find(function (o) { return o.value.trim(); });
    if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event("change", { bubbles: true })); }
  }, courseId);
  return true;
}

module.exports = { configureCourse: configureCourse };
