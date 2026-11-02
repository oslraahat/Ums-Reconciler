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
| Add course | page found, flow not mapped — `/Student/AddCourse/AddCourseOrSubject` |
| Due payment | page found, flow not mapped — `/Student/Payment/StudentDuePayment` |
| Transfer | page found, first step mapped — `/Student/StudentTransfer/Create`; the one the whole report hangs on |
| Program migration | page found, flow not mapped — `/Student/StudentMigrationHistory/StudentProgramMigration` |
| Class/exam entry | **not found** — needed to make scenario 5's opposite (a row WITH classes) |

So four flows have to be reverse-engineered before any of scenarios 2, 3, 4, 8 or 10 can be built.
That is read-only work and it comes first.

### What the first discovery run found, on ums-3

All four pages answer HTTP 200 and their addresses are now known — they were not before, and they
came out of the left menu of any UMS page, 247 links of it. The neighbours are worth noting too:
`/Student/StudentTransfer/TransferList`, `TransferSettlement`, `TransferReport`, and
`/Student/StudentMigrationHistory/MigrationPaymentHistory`.

The Transfer page's first step is mapped: `POST /Student/StudentTransfer/Create` with a single field,

```
stdRollOrRegistrationNo=<reg>
```

which is a LOOKUP — the same url serves the page on GET and finds the student on POST. The transfer
itself is a second step that only exists after that lookup has returned.

**And that is where fetching stops being enough.** The second step's fields are rendered by the
first step's response into a page that is already running; there is no address to ask for them. Nor
can the tool make the lookup call itself: the path says `Create`, so it classifies as a WRITE and is
refused — correctly, since nothing about the name tells it that this particular POST only reads.

The way through is the one `menus/cc/cc-page.js` already takes for Course Cancel: a content script
drives the real page in a real tab, reads what came back, and reports it. That is also how these
flows will have to be driven, so the mapping and the building are the same work rather than two.

### Every one of these flows starts with the same lookup

All four pages carry the same input, `#stdRollOrRegistrationNo`, and each asks its own controller for
the student before showing anything else:

| Flow | Lookup | Its button |
|---|---|---|
| Transfer | `POST /Student/StudentTransfer/Create` `{stdRollOrRegistrationNo}` | `#studentPrn` "Find Student" |
| Add course | `POST /Student/AddCourse/GenerateStudentProgramDetails` `{stdRollOrRegistrationNo}` | — |
| Program migration | `POST /Student/StudentMigrationHistory/StudentProgramMigration` (project-root + the same path) | — |
| Due payment | **not yet found** — the page has the input and a `#searchByprNo` "Submit" button, but no url literal; it posts some other way | — |
| Course Cancel (already built) | `POST /Student/CancelCourse/GenerateStudentProgramDetails` | — |

`GenerateStudentProgramDetails` is the same action on three different controllers, and Course Cancel
has been calling it read-only since it shipped — which is the strongest corroboration available that
it only reads.

The Transfer lookup is confirmed against ums-3: HTTP 200, an HTML fragment, and for a number it does
not know, "Please provide valid Registration No./ Roll No.". So it validates and reports rather than
creating anything.

### How a POST to a path called Create is allowed at all

The write-endpoint refusal is a pattern over the path, and the path says `Create`. Loosening the
pattern to let the Transfer lookup through would let through everything else named Create, so the
pattern stays and the exceptions are listed one at a time, in `VERIFIED_READS` in
`tools/discover.js`. Each entry carries:

- the exact path,
- the exact fields it may be sent — one extra field and it is refused, because a lookup given
  fields it does not take is no longer the request that was verified,
- and the evidence that it only reads, in prose, from the page's own script.

An entry is still not enough on its own: `--allow-verified-read` has to be on the command line, so
no POST to a path named like a write can happen by default or by accident. The tool says, on stderr,
every time it uses an exception and why.

An entry is a claim. It is written down, it names its evidence, and it is one line to remove.

### What is left

- Due payment's lookup endpoint.
- The second step of each flow — the fields that only exist after the lookup has returned. These
  come from the lookup's own HTML fragment, which is now reachable for three of the four.
- Class/exam entry, for scenario 4's control (money with a class for the value to have moved to).

To go further on the second steps I need a Registration No. or Roll that exists on the server being
mapped: `5574286` is not one on ums-3.

Three things the first run taught about the tool itself, all now fixed:

- Git Bash on Windows rewrites `--page /Student/X` into `C:/Program Files/Git/Student/X` before the
  program sees it. Pasted onto the base, that gave `https://ums-3.osl.teamC:/…`, whose hostname
  parses as `ums-3.osl.teamc` — and all that was said about it was "fetch failed".
- "fetch failed" is undici saying a network error happened and nothing about which. The cause
  carries the code, and ENOTFOUND is the difference between a wrong address and a server that is
  down.
- The cascade was invisible. These pages call their own controller as
  `$("body").attr("data-project-root") + "Controller/Action"` — no leading slash — so a pattern that
  required one found only the left menu's links, and every page reported the same two loaders from
  the shared layout. The dropdowns turned out to be server-rendered anyway, and the only scripts
  loaded are generic libraries, which is itself the finding: there is no per-page bundle to read.

## 3a · The discovery tool

`tools/discover.js` does step 1 repeatably, and makes the refusals automatic rather than remembered:

```
UMS_COOKIE=".UERP_AUTH=…" node tools/discover.js --base https://ums-4.osl.team \
  --page /Student/FranchisorTransaction/Create
```

It reports the page's forms, fields, dropdowns (naming the ones a loader fills, which is the
cascade), the antiforgery token, and every endpoint the page's own script references — each
classified loader / WRITE / unknown. With `--loader` it will ask a loader a question; with anything
else it refuses and says so.

The cookie comes from the environment, never the command line, so it stays out of shell history,
and it is never printed.

What it will not do: touch a host that is not `https://*.osl.team` (checked on the parsed hostname —
a substring test passes `osl.team.evil.com`); POST to anything that is not a loader; send a
password; or treat a login page as the page that was asked for.

`tests/discover.js` asks those decisions directly rather than running the tool. The first version of
that test ran it, and with the loader guard broken on purpose — to check the test would notice — the
tool went on and POSTed to `/Student/Admission/NewStudentAdmission` on ums-4. A test for a refusal
must not depend on the refusal working.

Two paths worth starting from are already referenced in the repo, from the Function Check sweeps:

- `/Student/FranchisorTransaction/Create` — very likely the **Transfer** flow, the one the whole
  report hangs on
- `/Student/FranchisorPercentSettings/Create` — where Base % comes from, which rule 2 checks against

## 4 · Order of work

1. **Discovery, read-only.** For each of the four unknown flows: open the page, record the cascade
   of loader calls, the form fields, and the write endpoint — as `docs/franchise-api.md` already
   does for the report. `tools/discover.js` above does this and refuses write endpoints while doing
   it.
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
