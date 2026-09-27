import { useState } from "react";
import useApi from "../../hooks/useApi";
import { getMyPlan, saveMyPlan } from "../../services/retirementService";
import Card from "../../components/ui/Card";
import FormField from "../../components/ui/FormField";
import Button from "../../components/ui/Button";
import LoadingState from "../../components/ui/LoadingState";
import ErrorState from "../../components/ui/ErrorState";

/**
 * The actual form, split into its own component so its local state can be
 * lazily initialized straight from the already-loaded plan/projection props
 * on mount - no effect needed to "sync" server data into form state.
 */
function PlanForm({ plan, projection, onSaved }) {
    const [form, setForm] = useState(() => ({
        target_amount: plan?.target_amount ?? "",
        target_retirement_age: plan?.target_age ?? "",
        monthly_contribution_target: projection?.assumed_contribution ?? "",
        current_age: "",
    }));
    const [submitting, setSubmitting] = useState(false);
    const [formError, setFormError] = useState("");
    const [successMessage, setSuccessMessage] = useState("");

    function handleChange(e) {
        const { name, value } = e.target;
        setForm((prev) => ({ ...prev, [name]: value }));
    }

    async function handleSubmit(e) {
        e.preventDefault();
        setFormError("");
        setSuccessMessage("");

        const payload = {
            target_amount: Number(form.target_amount),
            target_retirement_age: Number(form.target_retirement_age),
            monthly_contribution_target: Number(form.monthly_contribution_target),
            current_age: Number(form.current_age),
        };

        setSubmitting(true);
        try {
            await saveMyPlan(payload);
            setSuccessMessage("Retirement plan saved successfully.");
            onSaved();
        } catch (err) {
            setFormError(err.message || "Failed to save retirement plan.");
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <Card title={plan ? "Update your plan" : "Create a retirement plan"}>
            {formError && <div className="form-error" style={{ marginBottom: 12 }}>{formError}</div>}
            {successMessage && <div className="form-success" style={{ marginBottom: 12 }}>{successMessage}</div>}
            <form className="form-grid" onSubmit={handleSubmit}>
                <FormField
                    id="target_amount"
                    label="Target amount (KSh)"
                    type="number"
                    min="1"
                    value={form.target_amount}
                    onChange={handleChange}
                    required
                />
                <FormField
                    id="current_age"
                    label="Your current age"
                    type="number"
                    min="1"
                    value={form.current_age}
                    onChange={handleChange}
                    required
                />
                <FormField
                    id="target_retirement_age"
                    label="Target retirement age"
                    type="number"
                    min="1"
                    value={form.target_retirement_age}
                    onChange={handleChange}
                    required
                />
                <FormField
                    id="monthly_contribution_target"
                    label="Planned monthly contribution (KSh)"
                    type="number"
                    min="0"
                    value={form.monthly_contribution_target}
                    onChange={handleChange}
                    required
                />
                <div className="form-actions">
                    <Button type="submit" variant="primary" loading={submitting}>
                        Save plan
                    </Button>
                </div>
            </form>
        </Card>
    );
}

function RetirementPlan() {
    const planApi = useApi(() => getMyPlan().catch((err) => (err.status === 404 ? null : Promise.reject(err))), []);

    if (planApi.loading) return <LoadingState message="Loading your retirement plan..." />;
    if (planApi.error) return <ErrorState message={planApi.error} onRetry={planApi.refetch} />;

    const plan = planApi.data?.plan;
    const projection = planApi.data?.projection;

    return (
        <div>
            <div className="page-header">
                <div>
                    <h1 className="page-title">Retirement Plan</h1>
                    <p className="page-subtitle">Set or update your retirement savings target.</p>
                </div>
            </div>

            {plan && (
                <div className="section card">
                    <h2 className="card-title">Current plan</h2>
                    <p>
                        Target: <strong>KSh {Number(plan.target_amount).toLocaleString()}</strong> by age{" "}
                        <strong>{plan.target_age}</strong>
                    </p>
                    <p>Status: {plan.plan_status}</p>
                </div>
            )}

            {/* key forces a fresh mount (and fresh lazy-initialized form
                state) whenever the plan identity changes after a refetch */}
            <PlanForm key={plan?.plan_id || "new"} plan={plan} projection={projection} onSaved={planApi.refetch} />
        </div>
    );
}

export default RetirementPlan;
