# Testing For Franchisor / For Franchisee per transfer type — what data each case needs

Six passes over an empty filter report nothing six times. That is what

```
Course Wise · Non-Transfer (0) ✓   No rows for this filter
Student Wise · Non-Transfer (0) ✓  No rows for this filter
…
```

means: not a pass, an absence. **Scan** (14.83) answers where the rows are instead of asking anyone
to guess their way through every session and branch by hand, and it names the transfer types that
have no data anywhere — because that gap is exactly what has to be created.

This document is the plan for creating it. Written before the write code, so the order of
operations and the irreversible steps are agreed rather than discovered.

---

## 1 · What produces each transfer type

The three values come from the UMS dropdown; `fr-core.js` carries them as `TRANSFER`.

| Value | Transfer Type | What a row under it means | What has to have happened |
|---|---|---|---|
| 30 | Non-Transfer | collection stayed where it was taken | an admission at the franchisee branch, money paid there, nothing transferred |
| 10 | Franchisee → All | the franchisee's collection is apportioned across branches | a student admitted at one franchisee branch whose classes are taken at another |
| 20 | Franchisor → Franchisee | the franchisor's collection moves to the franchisee | money taken centrally against a course delivered by the franchisee |

Non-Transfer settles as Net Collection × Base %, with no service split — which is why rule 4 does
not apply there (it read as a 2.2-crore discrepancy before it was scoped). The other two apportion
the remainder after the base cut by classes taken, and that is where every interesting failure has
been: see `classes = 0` below.

## 2 · The cases, and what each one is for

Each row is a scenario the check should have something to say about. "Rule" names the arithmetic in
`checkRows()` the scenario exercises.

| # | Scenario | Built from | Rule it exercises |
|---|---|---|---|
| 1 | plain admission, paid in full, one course | admission | 1, 2, 3 |
| 2 | admission + a second course added later | admission → add course | 1, 2 — two course rows for one student, so per-row drift appears legitimately |
| 3 | admission with a due, paid later | admission → due payment | 1 — collection grows after the fact; Period filter boundaries |
| 4 | classes taken at a different branch | admission → transfer | 4, and the whole apportionment |
| 5 | **no classes at all, money paid** | admission, no class/exam entered | `fv_f_noclass` — the one real finding so far |
| 6 | one course cancelled, the other kept | admission → add course → cancel course | 1, 2 — cancellation changes Total Collection but not the base % |
| 7 | all courses cancelled | admission → cancel course | the zero-row and all-cancelled edges |
| 8 | moved to another program mid-session | admission → program migration | whether the collection follows the migration or stays |
| 9 | Session 2022 | admission in an older session | **no QA coverage at all** — 652 cases, none in 2022 |
| 10 | transfer on the boundary day | admission → transfer dated the first/last day of the Period | **no QA coverage** — every class-based case uses `class 8/12` only |

Rows 9 and 10 are not in the QA suite. They are in this list because the suite's own gaps are worth
covering, not because a case asks for them.

## 3 · What the tool can already do, and what it cannot

| Step | Status |
|---|---|
| New admission | **built** — `menus/adm/adm.js`, posts `/Student/Admission/NewStudentAdmission`, gated to `*.osl.team`, sequential or parallel, with a receipt read back |
| Cancel course | **built** — `menus/cc/`, from a sheet of (Reg, StudentProgramId, CourseId), dry run first |
| Add course | **not built** — endpoint not yet known |
| Due payment | **not built** — endpoint not yet known |
| Transfer | **not built** — endpoint not yet known; this is the one the whole report hangs on |
| Program migration | **not built** — endpoint not yet known |
| Class/exam entry | **not built** — needed to make scenario 5's opposite (a row WITH classes) |

So four flows have to be reverse-engineered before any of scenarios 2, 3, 4, 8 or 10 can be built.
That is read-only work and it comes first.

## 4 · Order of work

1. **Discovery, read-only.** For each of the four unknown flows: open the page, record the cascade
   of loader calls, the form fields, and the write endpoint — as `docs/franchise-api.md` already
   does for the report. The probe refuses write endpoints while discovering.
2. **Dry run.** Assemble each scenario's payload and display it. Write nothing. This is the step to
   check before anything is sent, and it is where a wrong field is cheap.
3. **Create, on the test server only.** Behind the same `*.osl.team` gate as New Admission. Real
   admissions create real records; nothing points at `umsbd.net` or `orgbd.net`.
4. **Check.** Run the six passes against the filter the data was created under, per transfer type.

## 5 · Rules that hold for the write steps

- `*.osl.team` only, checked on the parsed hostname, not by string match. `umsbd.net` and
  `orgbd.net` stay read-only.
- **A password is never filled and never submitted.** Not in a form, not in a payload, not as a
  default.
- Every created record is reported with its Reg and StudentProgramId, so it can be found and undone
  by hand.
- Dry run is the default. Creating is a separate, explicit press.
- One scenario at a time until each is known to produce the row it was meant to produce. The
  parallel runner exists in `adm.js`, but a scenario that creates the wrong data faster is worse.

## 6 · The finding this is all for

Running Student Wise live against ums-3 on 14.79: 802 rows, not one per-row rule broken, yet 3 of 9
branch/transfer combinations failed the report balance — each tracing to exactly one row with
`classes = 0`. 400, 2,000 and 10,000 taka left over after the base cut, with no owner. The FRS
divides the remainder by classes taken; its guard puts 0 in Value of Service; it never says whose
the rest is.

Scenario 5 is that case, built on purpose rather than found by luck. Scenario 4 is its control: the
same money with a class somewhere for the value to have moved to.
