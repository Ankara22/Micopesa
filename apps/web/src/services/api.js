import axios from "axios";

// Base URL is configurable via VITE_API_URL so it can point at any Express
// API instance (local dev, staging, etc.) without code changes.
const API_BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:5000";

const api = axios.create({
    baseURL: API_BASE_URL,
    headers: {
        "Content-Type": "application/json",
    },
});

// Attach the JWT (if present) to every outgoing request.
api.interceptors.request.use((config) => {
    const token = localStorage.getItem("micopesa_token");
    if (token) {
        config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
});

// Normalize errors into a predictable shape so callers never need to worry
// about whether the failure came from the network or from the API itself.
api.interceptors.response.use(
    (response) => response,
    (error) => {
        if (error.response) {
            // The server responded with a non-2xx status code.
            return Promise.reject({
                status: error.response.status,
                message: error.response.data?.message || "An unexpected error occurred",
                data: error.response.data,
            });
        }

        if (error.request) {
            // The request was made but no response was received (network
            // error, backend down, CORS issue, etc.).
            return Promise.reject({
                status: null,
                message: "Unable to reach the server. Please check your connection and try again.",
                data: null,
            });
        }

        // Something happened while setting up the request.
        return Promise.reject({
            status: null,
            message: error.message || "An unexpected error occurred",
            data: null,
        });
    }
);

export default api;
export { API_BASE_URL };
