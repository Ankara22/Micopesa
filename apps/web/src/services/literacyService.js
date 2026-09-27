import api from "./api";

export async function getArticles() {
    const res = await api.get("/api/literacy");
    return res.data.data;
}
