function DarkChartTooltip({ active, label, payload, formatter = (value) => value }) {
    if (!active || !payload?.length) return null;

    return (
        <div className="dashboard-chart-tooltip" style={{ padding: "10px 12px" }}>
            <p className="dashboard-chart-tooltip-label">{label}</p>
            {payload.map((item) => (
                <p className="dashboard-chart-tooltip-row" key={item.dataKey} style={{ color: item.color }}>
                    {item.name}: {formatter(item.value)}
                </p>
            ))}
        </div>
    );
}

export default DarkChartTooltip;
