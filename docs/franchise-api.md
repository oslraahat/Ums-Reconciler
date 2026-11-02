# UMS Franchise Calculation — API map (reverse-engineered from ums-3, Nov 2026)

How the Franchisor/Franchisee pages actually talk to the server. Gathered by reading the pages'
inline scripts, then confirmed against the live test server.

## The one rule that cost an hour

**Never send a `RequestVerificationToken` header.** With it, UMS answers `302 →
/Home/PermissionDenied?message=Permission Denied. User appropiate login`, which reads like an auth
failure and is not one. Without it, the same request succeeds. The session cookie alone is enough.

Required headers: `Cookie`, `X-Requested-With: XMLHttpRequest`, `Referer` (the owning page).
Bodies are form-encoded (`application/x-www-form-urlencoded`), not JSON — jQuery's default.
Array parameters use `name[]=value`.

## Cascade: how the filters get their options

| Step | Method | Endpoint | Body |
|---|---|---|---|
| Programs | POST | `/Administration/CommonAjax/LoadProgram` | `organizationIds[]`, `isAuthorized` |
| Sessions | POST | `/Administration/CommonAjax/LoadSession` | `organizationIds[]`, `programIds[]`, `isAuthorized` |
| Courses | POST | `/Administration/CommonAjax/LoadCourse` | `organizationIds[]`, `programIds[]`, `sessionIds[]` |
| Franchisee branches | GET | `/Student/FranchisorCalculation/LoadFranchiseeBranch` | `organizationId`, `programId` |

## The calculation itself

`POST /Student/FranchisorCalculation/CourseWiseDataTable` — a DataTables response.

Parameters (exactly what the page's own `reportParams()` builds):

    organizationId, programId, sessionId, franchiseeBranchId,
    courseIds        // comma-joined, empty = all
    transferType     // 10 = Franchisee→All, 20 = Franchisor→Franchisee, 30 = Non-Transfer
    dateFrom, dateTo // "till date" mode sends dateFrom empty and the date in dateTo
    showZeroPayment  // true shows Full Free / zero-payment students

Each row:

    CourseId, CourseName, SessionName,
    SelectedBranch          : { BranchId, BranchName, NetCollection, Services, ValueOfService, NetReceivable }
    OtherFranchiseeBranches : [ same shape ]
    FranchisorBranch        : { same shape }
    TotalCollection, FranchisorPercent,
    ReceivableAgainstBasePercent, FranchisorTotalReceivable, FranchisorNetReceivable

Missing/invalid mandatory filters answer `{"error":"Error code: 9999."}` with an empty `data`.

Related: `CourseWiseExport?<same params>` (file), and StudentWise is opened as a normal page with the
same parameters on the query string.

## Settings / entry pages

`/Student/FranchisorPercentSettings/Create` — the Base % per course.
  - `POST /Student/FranchisorPercentSettings/LoadFranchiseBranch` `{organizationId, courseId, focusSettingId}`
  - `POST /Student/FranchisorPercentSettings/Create` (or `/Edit`) — body is `JSON.stringify(viewModel)`

`/Student/FranchisorTransaction/Create` — Receipt / Payment / Adjustment. Field ids:
`Category, TransactionDate, OrganizationId, ProgramId, SessionId, CourseId, HeadId,
FranchiseeBranchId, Mode, DepositedBankId/BranchId/AccountId, DepositorBankId/BranchId/AccountId,
ChequeNo, SenderOperator/SenderNo, ReceiverOperator/ReceiverNo, Amount, OwnBranchId, Remarks`,
plus the Program→Program adjustment block (`P2pDate, P2pOrganizationId, …`).

All pages wrap their calls in `loadingAjax(options)` (blockUI + a generic error toast), so a failure
surfaces as "Something went wrong. Please try again." rather than the real message.

## Live IDs on ums-3 (for scenario setup)

Organizations: 1 UDVASH · 2 UNMESH · 3 OSL · 11 Shikkha Poribar · 12 UTTORON · 13 ONLINE CARE · 14 UTKORSHO
Programs (org 1): 68 Engineering Admission · 82 Varsity 'KA' · 198 Varsity 'KHA' · 67 College Admission · 65 SSC Model Test · 66 HSC Model Test
Sessions: 72=2028 · 70=2027 · 66=2026 · 65=2025 · 63=2024 · 61=2023
Franchisee branches (org 1): 89 Rajshahi Kadirganj · 92 Khulna Shantidham Mor · 81 Science Lab · 82 Uttara House Building · 651 Udvash Franchise

The QA suite's scenarios are written around "Rajshahi", which is branch **89** here.

---

# Creating the data a scenario needs (ums-3, mapped Nov 2026)

What a script must drive to produce a student, a payment and a transfer. All of it writes real
records, so it belongs behind an explicit switch.

## New admission

The page is a shell; the logic lives in `/Scripts/Student/NewAdmission.js`. Walked read-only
against ums-3, so the parameter names and shapes below are what the server actually answered, not
what the field labels suggest.

**Two things are easy to get wrong.**

First, these loaders do not return data. They return rendered `<option>` markup inside a JSON
string — `{"SessionOptions": "<option value=\"66\">2026</option>…"}` — so the options have to be
parsed out. Treating the reply as a list of objects yields an empty list and no error.

Second, and the one that costs real time: **the course list is not its own endpoint.** It arrives
from `GetBranchByProgramSession` — but only when `isOnlyBranch` is **false**. With `true` the reply
carries `BrunchOptions` alone; with `false` it also carries `CourseView`, ~144 KB of markup holding
the course checkboxes. That is the only place the course ids live, and `studentObj` cannot be built
without them. `sessionChange()` is what calls it that way, and it empties `#CouseCheckList` first
(the typo is theirs).

    POST GetSessionByProgram               { programId, sessionId }
    POST GetBranchByProgramSession         { programId, sessionId, studentId, isOffice,
                                             versionStudy, gender, isOnlyBranch, selectedCourseId }
         → SessionOptions, BrunchOptions, AttachedPhysicalBrunchOptions,
           CourseView  ← the course checkboxes, only when isOnlyBranch = false
           ExamBoardView, MaxNextPaymentDate
    POST GetCampusByProgramSessionAndBranch { branchId, campusId, programId, sessionId,
                                              versionStudy, gender }
    POST GetBatchDayByProgramSessionBranchAndCampus  { …, courseIds }
    POST GetBatchTimeBy… / GetBatchBy…

Each course checkbox in `CourseView` carries what the payload needs:

    data-course-id · data-course-name · data-officeminsub · data-maximumsubject
    data-isofficecompulsary · data-program-id · data-session-id

Then the money, which needs the assembled student rather than ids:

    POST /Student/Admission/CalculateCourseFee
         { format: "json", studentViewModelJson: <studentObj>, previousStudentId, bookingId }

and only then the write:

    POST /Student/Admission/NewStudentAdmission   { studentObj, boardInfos }

`studentObj` is assembled by `getStudentInfoJson()`:

    Name, MobNumber, Program, Session, Branch, Campus, AttachedPhysicalBranch,
    VersionOfStudy, Gender, Religion, Email, LastInstituteName, LastInstituteId
    Courses[]: Id, Name, ProgramId, SessionId, IsTaken, BatchId, BranchId, CampusId,
               OfficeMinSub, maxSubject, IsOfficeCompulsary, + subjects and the discount fields

`POST /Student/Admission/StudentRegistration { studentObj }` is the registration-only variant
(`#saveStudent`), without payment.

### Resolved on ums-3, for the QA suite's own scenario

    Program 68  Engineering Admission Program
    Session 66  2026            Gender 1 Male · VersionOfStudy 1 Bangla
    Branch  89  Rajshahi Kadirganj Udvash   ← the suite's "Rajshahi"
    Campus 100  Rajshahi Campus
    Course 2474 Engineering Full Course 2026 [Offline]  (minSub 4, maxSub 4)

15 courses come back for that combination.

## The follow-on pages are search-then-act

They render almost nothing until a student is loaded, so each needs the Roll/Reg produced above:

| Page | Entry field | Action |
|---|---|---|
| Student Due Payment | `stdRollOrRegistrationNo` | `POST /Student/Payment/DuePayment` |
| Student Transfer | `PrnNoFirst` | `POST /Student/StudentTransfer/Create` |
| Add Course / Cancel Course | the grid at `#DataGrid` | see menus/cc/cc-page.js, which already drives Cancel |

`menus/cc/cc-page.js` is the working precedent for driving one of these flows: it runs inside the
page, reads `#DataGrid`, posts to `GenerateStudentProgramDetails`, and copes with `.blockUI` and
`.bootbox`.

## Why this cannot be done from the panel alone

Unlike the report endpoints, these flows depend on page state that only exists after the cascade has
run in a real document. The established pattern in this codebase is an injected page script
(cc-page.js), driving the real UI with the user's own session, rather than replaying POSTs blind.

---

## The Summary Report — the third level

Read off ums-3 on 2 Nov 2026. Unlike the other two levels the arithmetic did not have to be
inferred: the page states it in its own column tooltips, and every rule was then checked against a
real row before being written into `checkSummary()`.

| Side | Page | Data endpoint |
|---|---|---|
| Franchisor | `/Student/FranchisorCalculation/Summary` | `POST SummaryReportDataTable` |
| Franchisee | `/Student/FranchiseeCalculation/SummaryReport` | `POST SummaryReportData` |

No Transfer Type at this level. A report type takes its place: the Franchisor posts `reportingType`
(1, 2) with `salesScope`, the Franchisee posts `reportType` — `SUMMARY_TYPE = { Franchisor: 10,
OtherFranchisee: 20 }` from the page's own script, with `reportingType` applying only when it is not
OtherFranchisee. On the filter tried, 10 answered with no rows and 20 with them.

**The branch is posted as `franchiseeBranchId`**, though the dropdown it comes from is `#BranchId`.
Posting `BranchId` answers `{"error":"Error code: 9999."}` and nothing else. The Franchisor endpoint
is server-side DataTables, so it also wants `draw`, `start` and `length`.

### Franchisor fields, and what the page says they are

`RowType, Particular, NetReceivable, ReceivedCash, ReceivedBank, ReceivedMfs, ReceivedTotal,
CollectedFromFranchisorStudents, FranchisorCollectedCash, FranchisorCollectedMerchant,
OtherAdjustment, AdjustmentTotal, TotalNetReceivable, IsSettled`

`RowType` ≠ 0 marks the report's own total lines — sums of the rows above them, not rows in their
own right.

    Total Received   = Cash + Bank + MFS
    Adjustment Total = (G − H − I − J)
    Total            = Net Receivable − Total Received + Adjustment Total
    Final Settled    ⇔ that total is zero

G is what the selected branch collected from Franchisor students; H and I what the Franchisor branch
collected from this branch's students, in cash and by MFS/merchant; J the cross-programme adjustment
made in the Adjustment menu.

Checked on EAP 2023, branch 89: `−192665 − (−186539) − 0 − 0 = −6126` = AdjustmentTotal, and
`−665041.66 − 0 + (−6126) = −671167.66` = TotalNetReceivable, with IsSettled false.

### Franchisee fields

`Particular, NetFromTransfer, OtherCollectedFromOwn, OwnCollectedFromOther, TotalReceivable,
ReceivedPaid, NetReceivable` — each an ARRAY, one entry per branch column, each with a matching
`*Total` scalar beside it. The answer also carries `Totals`, `OtherBranches` and `Header`.

    each *Total      = that column's entries added up
    Total Receivable = Net from Transfer + Other Collected from Own − Own Collected from Other
    Net Receivable   = Total Receivable − Received/Paid

Checked on the same programme's two columns: `49343.52 + 15000 − 19500 = 44843.52` and
`102.56 + 0 − 19000 = −18897.44`, both matching TotalReceivable.

### The check that needs two levels

The Franchisor page says its Net Receivable comes from "Course Wise Calculation থেকে
(Franchisee→Franchisor T + Franchisor→Franchisee T + Non-Transfer E)" — so it should equal what the
Course Wise level reports over the three transfer types. Neither level can say this alone, and
nobody checks it by eye across two screens, which is why it is the one check worth most here. It
runs after all three levels, Franchisor-side only.
