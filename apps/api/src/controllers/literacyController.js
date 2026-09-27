// Static financial-literacy content. There is no dedicated database table
// for this (schema.sql has no FINANCIAL_LITERACY entity), so the content is
// served as a small curated, hardcoded catalogue rather than invented DB
// tables/columns.
const ARTICLES = [
    {
        id: "why-save-early",
        title: "Why Saving Early Matters",
        summary: "Understand how compounding growth makes small, regular contributions powerful over time.",
        body:
            "Even small monthly contributions can grow significantly over decades thanks to " +
            "compound interest. Starting at 25 instead of 35 can more than double your retirement " +
            "savings for the same monthly amount.",
    },
    {
        id: "choosing-a-contribution-channel",
        title: "Choosing the Right Contribution Channel",
        summary: "M-Pesa, bank transfer, or USSD - pick what fits your routine.",
        body:
            "MicoPesa supports M-Pesa, bank, and USSD contributions. Choose the channel that's " +
            "easiest for you to use consistently - consistency matters more than the amount.",
    },
    {
        id: "understanding-fund-risk-levels",
        title: "Understanding Fund Risk Levels",
        summary: "LOW, MEDIUM, and HIGH risk funds explained.",
        body:
            "Lower-risk funds prioritize capital protection with modest growth. Higher-risk funds " +
            "aim for larger growth but can fluctuate more. Your ideal mix depends on how many years " +
            "remain until retirement.",
    },
    {
        id: "when-can-i-withdraw",
        title: "When Can I Withdraw My Savings?",
        summary: "What to know before submitting a withdrawal claim.",
        body:
            "Withdrawal claims are reviewed by a Fund Manager before payout. Make sure your account " +
            "is active and your requested amount does not exceed your current balance to avoid delays.",
    },
];

/**
 * GET /api/literacy
 * WORKER only. Returns the static financial-literacy article catalogue.
 */
async function listArticles(req, res) {
    return res.status(200).json({ status: "success", data: ARTICLES });
}

module.exports = { listArticles };
