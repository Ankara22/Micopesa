import { useState } from "react";
import Card from "../ui/Card";
import FormField from "../ui/FormField";
import Button from "../ui/Button";
import { useToast } from "../ui/ToastContext";
import "./retirement.css";

function PlanForm({ plan, projection, onSaved }) {
    const toast = useToast();
    const [form, setForm] = useState(() => ({
        current_age: plan && projection
            ? String(Number(plan.target_age) - Number(projection.projection_years))
            : "",
        target_retirement_age: plan?.target_age ?? "",
        target_amount: plan?.target_amount ?? "",
        monthly_contribution_target: projection?.assumed_contribution ?? "",
    }));
    const [submitting, setSubmitting] = useState(false);

    function handleChange(event) {
        const { name, value } = event.target;
        setForm((current) => ({ ...current, [name]: value }));
    }

    async function handleSubmit(event) {
        event.preventDefault();
        setSubmitting(true);

        try {
            const result = await onSaved({
                current_age: Number(form.current_age),
                target_retirement_age: Number(form.target_retirement_age),
                target_amount: Number(form.target_amount),
                monthly_contribution_target: Number(form.monthly_contribution_target),
            });
            if (result) toast.success("Your retirement plan and projection have been updated.");
            else toast.error("The plan was saved, but the latest projection could not be refreshed.");
        } catch (saveError) {
            toast.error(saveError.message || "Unable to save your retirement plan.");
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <Card
            title={plan ? "Update your retirement plan" : "Create Your Retirement Plan"}
            className="retirement-card"
        >
            {!plan && (
                <p className="retirement-intro">
                    Start planning for the future. Set a savings goal and contribution target to see
                    how your savings could grow.
                </p>
            )}
            <form className="retirement-form" onSubmit={handleSubmit}>
                <div className="retirement-form-grid">
                    <FormField
                        id="current_age"
                        label="Current age"
                        type="number"
                        min="1"
                        max="99"
                        step="1"
                        required
                        value={form.current_age}
                        onChange={handleChange}
                    />
                    <FormField
                        id="target_retirement_age"
                        label="Target retirement age"
                        type="number"
                        min="2"
                        max="100"
                        step="1"
                        required
                        value={form.target_retirement_age}
                        onChange={handleChange}
                    />
                    <FormField
                        id="target_amount"
                        label="Target amount (KES)"
                        type="number"
                        min="0.01"
                        step="0.01"
                        required
                        value={form.target_amount}
                        onChange={handleChange}
                    />
                    <FormField
                        id="monthly_contribution_target"
                        label="Monthly contribution target (KES)"
                        type="number"
                        min="0"
                        step="0.01"
                        required
                        value={form.monthly_contribution_target}
                        onChange={handleChange}
                    />
                </div>
                <div className="form-actions">
                    <Button type="submit" variant="primary" loading={submitting}>
                        {plan ? "Update plan" : "Create plan"}
                    </Button>
                </div>
            </form>
        </Card>
    );
}

export default PlanForm;
