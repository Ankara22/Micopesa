export function getProfileAge(dateOfBirth, today = new Date()) {
    if (typeof dateOfBirth !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)) {
        return null;
    }

    const [year, month, day] = dateOfBirth.split("-").map(Number);
    const birthDate = new Date(Date.UTC(year, month - 1, day));
    if (
        birthDate.getUTCFullYear() !== year ||
        birthDate.getUTCMonth() !== month - 1 ||
        birthDate.getUTCDate() !== day
    ) {
        return null;
    }

    let age = today.getUTCFullYear() - year;
    if (
        today.getUTCMonth() < month - 1 ||
        (today.getUTCMonth() === month - 1 && today.getUTCDate() < day)
    ) {
        age -= 1;
    }
    return age >= 1 && age <= 100 ? age : null;
}
