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

The page is a shell; the logic is `/Scripts/Student/NewAdmission.js`. Every dropdown is a step in a
cascade, each one POSTing to the next:

    GetProgramByClass -> GetSessionByProgram -> GetBranchByProgramSession
      -> GetCampusByProgramSessionAndBranch
      -> GetBatchDayByProgramSessionBranchAndCampus
      -> GetBatchTimeByProgramSessionBranchCampusAndBatchDay
      -> GetBatchByProgramSessionBranchCampusAndBatchDayTime

then `POST /Student/Admission/CalculateCourseFee` for the money, and finally

    POST /Student/Admission/NewStudentAdmission   { studentObj, boardInfos }

`studentObj` is assembled by `getStudentInfoJson()`:

    Name, MobNumber, Program, Session, Branch, Campus, AttachedPhysicalBranch,
    VersionOfStudy, Gender, Religion, Email, LastInstituteName, LastInstituteId
    Courses[]: Id, Name, ProgramId, SessionId, IsTaken, BatchId, BranchId, CampusId,
               OfficeMinSub, maxSubject, IsOfficeCompulsary, + subjects and the discount fields

The course rows carry their own ids as `data-course-id` / `data-officeminsub` /
`data-maximumsubject` / `data-isofficecompulsary` attributes, so the course list has to be fetched
and parsed before studentObj can be built — the ids are not knowable in advance.

`POST /Student/Admission/StudentRegistration { studentObj }` is the registration-only variant
(`#saveStudent`), without payment.

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
