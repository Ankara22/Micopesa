self.addEventListener("push", (event) => {
    let payload;
    try {
        payload = event.data ? event.data.json() : {};
    } catch {
        payload = {};
    }

    const title = typeof payload.title === "string" && payload.title.trim()
        ? payload.title.trim().slice(0, 100)
        : "MicoPesa";
    const body = typeof payload.body === "string" ? payload.body.slice(0, 5000) : "";
    const url = safeAppUrl(payload.url);

    event.waitUntil(self.registration.showNotification(title, {
        body,
        data: { url },
    }));
});

function safeAppUrl(value) {
    if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
        return "/worker/notifications";
    }
    try {
        const url = new URL(value, self.location.origin);
        return url.origin === self.location.origin
            ? `${url.pathname}${url.search}${url.hash}`
            : "/worker/notifications";
    } catch {
        return "/worker/notifications";
    }
}

self.addEventListener("notificationclick", (event) => {
    event.notification.close();
    const targetUrl = new URL(
        safeAppUrl(event.notification.data?.url),
        self.location.origin
    ).href;

    event.waitUntil(
        self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
            const existing = clients.find((client) => new URL(client.url).origin === self.location.origin);
            if (existing) {
                return existing.navigate(targetUrl).then(() => existing.focus());
            }
            return self.clients.openWindow(targetUrl);
        })
    );
});
