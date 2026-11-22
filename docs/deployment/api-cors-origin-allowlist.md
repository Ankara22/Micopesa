# API CORS origin allowlist

The API serves browser requests only from origins listed in
`CORS_ALLOWED_ORIGINS`, a comma-separated list of exact origins with no paths
or trailing slashes. Production requires the variable and accepts HTTPS origins
only. Missing or invalid production configuration prevents the API from
starting.

Configure every deployed frontend origin explicitly, for example:

```text
CORS_ALLOWED_ORIGINS=https://app.example.org,https://admin.example.org
```

Non-production environments default to `http://localhost:5173` and
`http://127.0.0.1:5173` when the variable is omitted. Do not use wildcard
origins. CORS is a browser policy, not authentication or authorization; API
routes must continue enforcing their existing server-side access controls.

## Webhook ingress

The M-Pesa callback and Mobile Sasa delivery-report middleware also maintain
bounded per-process request counters. They are a local overload safeguard, not
a distributed rate limit: multiple API instances do not share counters, and a
reverse proxy may make all requests appear to originate from one address.
Production deployments must apply a shared rate limit at the trusted ingress
or load balancer for both webhook paths. Configure forwarded-client-address
handling only for known proxy hops; never trust a client-supplied forwarding
header directly. Preserve the Mobile Sasa signature and timestamp checks and
the existing request-body limits.
