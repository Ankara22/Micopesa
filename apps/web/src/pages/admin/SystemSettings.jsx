import { useState } from "react";
import useApi from "../../hooks/useApi";
import { listSettings, createSetting, updateSetting, deleteSetting } from "../../services/adminService";
import DataTable from "../../components/ui/DataTable";
import Button from "../../components/ui/Button";
import Modal from "../../components/ui/Modal";
import FormField from "../../components/ui/FormField";

const EMPTY_FORM = { setting_key: "", setting_value: "", description: "" };

function SystemSettings() {
    const settingsApi = useApi(listSettings, []);
    const [modalOpen, setModalOpen] = useState(false);
    const [editingSetting, setEditingSetting] = useState(null);
    const [form, setForm] = useState(EMPTY_FORM);
    const [submitting, setSubmitting] = useState(false);
    const [formError, setFormError] = useState("");
    const [deletingKey, setDeletingKey] = useState(null);

    function openCreateModal() {
        setEditingSetting(null);
        setForm(EMPTY_FORM);
        setFormError("");
        setModalOpen(true);
    }

    function openEditModal(setting) {
        setEditingSetting(setting);
        setForm({
            setting_key: setting.setting_key,
            setting_value: setting.setting_value,
            description: setting.description || "",
        });
        setFormError("");
        setModalOpen(true);
    }

    function handleChange(e) {
        const { name, value } = e.target;
        setForm((prev) => ({ ...prev, [name]: value }));
    }

    async function handleSubmit(e) {
        e.preventDefault();
        setFormError("");
        setSubmitting(true);
        try {
            if (editingSetting) {
                await updateSetting(editingSetting.setting_key, {
                    setting_value: form.setting_value,
                    description: form.description,
                });
            } else {
                await createSetting(form);
            }
            setModalOpen(false);
            settingsApi.refetch();
        } catch (err) {
            setFormError(err.message || "Failed to save setting.");
        } finally {
            setSubmitting(false);
        }
    }

    async function handleDelete(key) {
        setDeletingKey(key);
        try {
            await deleteSetting(key);
            settingsApi.refetch();
        } catch {
            // Surfaced implicitly via the table staying unchanged; a toast
            // system could report this more visibly in a future iteration.
        } finally {
            setDeletingKey(null);
        }
    }

    const columns = [
        { key: "setting_key", header: "Key" },
        { key: "setting_value", header: "Value" },
        { key: "description", header: "Description", render: (row) => row.description || "-" },
        {
            key: "actions",
            header: "",
            render: (row) => (
                <div style={{ display: "flex", gap: 8 }}>
                    <Button variant="secondary" size="sm" onClick={() => openEditModal(row)}>
                        Edit
                    </Button>
                    <Button
                        variant="danger"
                        size="sm"
                        loading={deletingKey === row.setting_key}
                        onClick={() => handleDelete(row.setting_key)}
                    >
                        Delete
                    </Button>
                </div>
            ),
        },
    ];

    return (
        <div>
            <div className="page-header">
                <div>
                    <h1 className="page-title">System Settings</h1>
                    <p className="page-subtitle">Manage platform configuration key/value pairs.</p>
                </div>
                <Button variant="primary" onClick={openCreateModal}>
                    + New Setting
                </Button>
            </div>

            <DataTable
                columns={columns}
                rows={settingsApi.data}
                rowKey="setting_key"
                loading={settingsApi.loading}
                error={settingsApi.error}
                onRetry={settingsApi.refetch}
                emptyMessage="No system settings have been configured yet."
            />

            <Modal open={modalOpen} title={editingSetting ? "Edit setting" : "Create setting"} onClose={() => setModalOpen(false)}>
                {formError && <div className="form-error" style={{ marginBottom: 12 }}>{formError}</div>}
                <form className="form-grid" onSubmit={handleSubmit}>
                    <FormField
                        id="setting_key"
                        label="Key"
                        value={form.setting_key}
                        onChange={handleChange}
                        disabled={Boolean(editingSetting)}
                        required
                    />
                    <FormField id="setting_value" label="Value" value={form.setting_value} onChange={handleChange} required />
                    <FormField id="description" label="Description" as="textarea" value={form.description} onChange={handleChange} />
                    <div className="form-actions">
                        <Button type="button" variant="secondary" onClick={() => setModalOpen(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" variant="primary" loading={submitting}>
                            Save
                        </Button>
                    </div>
                </form>
            </Modal>
        </div>
    );
}

export default SystemSettings;
