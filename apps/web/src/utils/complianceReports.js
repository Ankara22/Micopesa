export const SYNTHETIC_DEMO_CLASSIFICATION = "SYNTHETIC_DEMO";
export const SYNTHETIC_DEMO_DISCLOSURE =
    "SYNTHETIC DEMONSTRATION ONLY - NOT A GENUINE REGULATORY SUBMISSION.";

export const REPORT_CATEGORIES = [
    { value: "QUARTERLY_CONTRIBUTION_RECONCILIATION", label: "Quarterly contribution reconciliation" },
    { value: "INVESTMENT_PERFORMANCE", label: "Investment performance" },
    { value: "ASSETS_AND_LIABILITIES", label: "Assets and liabilities" },
    { value: "COMPLIANCE_CHECKLIST", label: "Compliance checklist" },
    { value: "GENERAL_COMPLIANCE", label: "General compliance report" },
];

function fictionalSection(details) {
    return `${SYNTHETIC_DEMO_DISCLOSURE} All figures and observations below are fictional and do not describe the selected fund. ${details}`;
}

export const SYNTHETIC_DEMO_TEMPLATES = {
    QUARTERLY_CONTRIBUTION_RECONCILIATION: {
        executive_summary: fictionalSection("Illustrative quarter: KES 120,000 expected contributions, KES 118,500 matched, and a fictional KES 1,500 difference pending review."),
        financial_summary: fictionalSection("The fictional reconciliation compares a KES 120,000 expected total with KES 118,500 in illustrative posted items. No actual account or payment data is represented."),
        risk_and_governance: fictionalSection("A fictional independent reviewer would trace the illustrative KES 1,500 difference to source records before sign-off."),
        incidents_and_actions: fictionalSection("No real incident is reported. The example action is to document a fictional variance investigation and its approval."),
        supporting_information: fictionalSection("Illustrative evidence would include fictional control totals and a mock reconciliation checklist, not real member records."),
    },
    INVESTMENT_PERFORMANCE: {
        executive_summary: fictionalSection("Illustrative quarterly investment performance is shown as 3.2 percent solely to demonstrate the report workflow."),
        financial_summary: fictionalSection("The fictional example uses a hypothetical opening value of KES 1,000,000 and closing value of KES 1,032,000 before fees."),
        risk_and_governance: fictionalSection("A demonstration review would compare the hypothetical return with an approved fictional benchmark and document assumptions."),
        incidents_and_actions: fictionalSection("No real investment event is reported. A fictional action is to review hypothetical market and valuation assumptions."),
        supporting_information: fictionalSection("All amounts and performance figures in this example are invented and are not investment or fund data."),
    },
    ASSETS_AND_LIABILITIES: {
        executive_summary: fictionalSection("This illustrative statement presents hypothetical assets and liabilities for demonstrating the reporting workflow only."),
        financial_summary: fictionalSection("The fictional example lists KES 250,000 in hypothetical assets and KES 245,000 in hypothetical liabilities."),
        risk_and_governance: fictionalSection("The demonstration control would reconcile fictional asset and liability schedules and document independent review."),
        incidents_and_actions: fictionalSection("No real financial exception is reported. A fictional action is to explain the hypothetical KES 5,000 difference."),
        supporting_information: fictionalSection("No real account, transaction, custodian, or financial statement is represented by these invented amounts."),
    },
    COMPLIANCE_CHECKLIST: {
        executive_summary: fictionalSection("This fictional checklist demonstrates how a manager can document controls without asserting actual compliance."),
        financial_summary: fictionalSection("No actual financial figures are included. Any values entered for a demonstration must remain clearly fictional."),
        risk_and_governance: fictionalSection("The example checklist covers hypothetical approval, segregation-of-duties, and record-retention controls."),
        incidents_and_actions: fictionalSection("No real incident or remediation is represented. Example actions are fictional workflow placeholders."),
        supporting_information: fictionalSection("Evidence references in this demonstration must be mock descriptions and must not identify real members or records."),
    },
    GENERAL_COMPLIANCE: {
        executive_summary: fictionalSection("This general example is fictional and exists only to demonstrate the compliance-report workflow."),
        financial_summary: fictionalSection("No actual financial results are represented in this demonstration section."),
        risk_and_governance: fictionalSection("This fictional section demonstrates how a manager might summarize governance controls and risks."),
        incidents_and_actions: fictionalSection("No real incident is represented. Any listed example action is fictional."),
        supporting_information: fictionalSection("This section contains no genuine regulatory evidence or member-level information."),
    },
};

export function isSyntheticDemo(content) {
    return content?.demo_classification === SYNTHETIC_DEMO_CLASSIFICATION;
}

export function getReportCategoryLabel(category) {
    return REPORT_CATEGORIES.find((item) => item.value === category)?.label || category || "Uncategorized";
}
