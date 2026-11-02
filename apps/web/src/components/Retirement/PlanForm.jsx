import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Card from "../ui/Card";
import FormField from "../ui/FormField";
import Button from "../ui/Button";
import { useToast } from "../ui/ToastContext";
import "./retirement.css";

function PlanForm({ plan, projection, onSaved }) {
    const { t } = useTranslation();
    const toast = useToast();
    const [form, setForm] = useState(() => ({
        current_age: projection?.current_age ?? "",
        target_retirement_age: plan?.target_age ?? "",
        target_amount: plan?.target_amount ?? "",
        monthly_contribution_target: projection?.assumed_contribution ?? "",
    }));
    const [submitting, setSubmitting] = useState(false);
    const submissionInProgressRef = useRef(false);

    function handleChange(event) {
        const { name, value } = event.target;
        setForm((current) => ({ ...current, [name]: value }));
    }

    async function handleSubmit(event) {
        event.preventDefault();
        if (submissionInProgressRef.current) return;
        submissionInProgressRef.current = true;
        setSubmitting(true);

        try {
            const result = await onSaved({
                current_age: Number(form.current_age),
                target_retirement_age: Number(form.target_retirement_age),
                target_amount: Number(form.target_amount),
                monthly_contribution_target: Number(form.monthly_contribution_target),
            });
            if (result) toast.success(t("worker.retirement.saveSuccess"));
            else toast.error(t("worker.retirement.saveRefreshError"));
        } catch {
            toast.error(t("worker.retirement.saveError"));
        } finally {
            submissionInProgressRef.current = false;
            setSubmitting(false);
        }
    }

    return (
        <Card
            title={plan ? t("worker.retirement.formTitleUpdate") : t("worker.retirement.formTitleCreate")}
            className="retirement-card"
        >
            {!plan && (
                <p className="retirement-intro">
                    {t("worker.retirement.intro")}
                </p>
            )}
            <form className="retirement-form" onSubmit={handleSubmit}>
                <div className="retirement-form-grid">
                    <FormField
                        id="current_age"
                        label={t("worker.retirement.currentAge")}
                        type="number"
                        min="1"
                        max="99"
                        step="1"
                        required
                        value={form.current_age}
                        onChange={handleChange}
                        disabled={submitting}
                    />
                    <FormField
                        id="target_retirement_age"
                        label={t("worker.retirement.retirementAge")}
                        type="number"
                        min="2"
                        max="100"
                        step="1"
                        required
                        value={form.target_retirement_age}
                        onChange={handleChange}
                        disabled={submitting}
                    />
                    <FormField
                        id="target_amount"
                        label={t("worker.retirement.goal")}
                        type="number"
                        min="0.01"
                        max="9999999999.99"
                        step="0.01"
                        required
                        value={form.target_amount}
                        onChange={handleChange}
                        disabled={submitting}
                    />
                    <FormField
                        id="monthly_contribution_target"
                        label={t("worker.retirement.monthlyContribution")}
                        type="number"
                        min="0"
                        max="9999999999.99"
                        step="0.01"
                        required
                        value={form.monthly_contribution_target}
                        onChange={handleChange}
                        disabled={submitting}
                    />
                </div>
                <div className="form-actions">
                    <Button type="submit" variant="primary" loading={submitting}>
                        {t("worker.retirement.calculate")}
                    </Button>
                </div>
            </form>
        </Card>
    );
}

export default PlanForm;
