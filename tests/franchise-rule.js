/* Franchise check — the header-rewrite rule stays in its lane.
 *
 *   node tests/franchise-rule.js
 *
 * The DNR rule is now path-scoped. Two things must hold, and the second is the whole point:
   every URL this feature calls must still match the scope, and the URLs other parts of the
   extension hit against the same UMS must NOT. Checked against the regex as it is on disk. */
const fs = require("fs");
const path = require("path");
const core = fs.readFileSync(path.join(__dirname, "..", "menus", "fr", "fr-core.js"), "utf8");
const m = core.match(/var RULE_PATHS = "([^"]+)"/);
if (!m) { console.log("FAIL  RULE_PATHS not found"); process.exit(1); }
const re = new RegExp(m[1]);
console.log("scope: " + m[1] + "\n");

const mustMatch = [
  "/Student/FranchisorCalculation/CourseWiseDataTable",
  "/Student/FranchiseeCalculation/CourseWiseCalculationData",
  "/Student/FranchisorCalculation/LoadFranchiseeBranch?organizationId=1&programId=68",
  "/Student/FranchiseeCalculation/LoadFranchiseeBranch",
  "/Administration/CommonAjax/LoadProgram",
  "/Administration/CommonAjax/LoadSession",
  "/Administration/CommonAjax/LoadCourse"
];
const mustNotMatch = [
  "/Student/Payment/PaymentHistory",
  "/Student/Payment/CourseWisePayment",
  "/Student/Admission/NewAdmission",
  "/Student/Admission/GetDiscountApprovedBy",
  "/Student/CancelCourse/GenerateStudentProgramDetails",
  "/Hr/CommonAjaxHr/GetTeamMemberNoticeCount",
  "/Administration/CommonAjax/LoadBranch",
  "/Administration/Branch/Index",
  "/Student/FranchisorPercentSettings/Create",
  "/Student/FranchisorTransaction/Create"
];

let fail = 0;
mustMatch.forEach(u => {
  const ok = re.test(u);
  if (!ok) fail++;
  console.log((ok ? "PASS  in scope      " : "FAIL  SHOULD match  ") + u);
});
console.log();
mustNotMatch.forEach(u => {
  const ok = !re.test(u);
  if (!ok) fail++;
  console.log((ok ? "PASS  left alone    " : "FAIL  WOULD rewrite ") + u);
});
console.log(fail ? "\n" + fail + " FAILED" : "\nসব ঠিক আছে");
process.exit(fail ? 1 : 0);
