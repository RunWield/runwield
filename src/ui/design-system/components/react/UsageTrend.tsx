interface UsageTrendPoint {
    date: string;
    tokens: number | null;
    gaps: string[];
}

interface UsageTrendProps {
    days: UsageTrendPoint[];
}

/** Null separates segments. A covered zero remains a visible point on the baseline. */
export function UsageTrend({ days }: UsageTrendProps) {
    const maximum = Math.max(1, ...days.map((day) => day.tokens ?? 0));
    const x = (index: number) => 20 + index * 760 / Math.max(1, days.length - 1);
    const y = (tokens: number) => 150 - tokens / maximum * 125;
    const segments: string[][] = [[]];
    days.forEach((day, index) => {
        if (day.tokens === null) segments.push([]);
        else segments.at(-1)!.push(`${x(index)},${y(day.tokens)}`);
    });
    return (
        <figure className="rw-usage-trend">
            <svg
                viewBox="0 0 800 175"
                role="img"
                aria-label="Daily reported tokens. Gaps break the line; covered zero days have a point. See the daily table for values."
            >
                <line className="rw-usage-baseline" x1="20" y1="150" x2="780" y2="150" />
                {segments.filter((segment) => segment.length > 1).map((segment, index) => (
                    <polyline key={index} className="rw-usage-line" points={segment.join(" ")} />
                ))}
                {days.map((day, index) =>
                    day.tokens === null
                        ? (
                            <text key={day.date} className="rw-usage-gap" x={x(index)} y="170" textAnchor="middle">
                                –
                            </text>
                        )
                        : (
                            <circle key={day.date} className="rw-usage-point" cx={x(index)} cy={y(day.tokens)} r="3">
                                <title>{`${day.date}: ${day.tokens} tokens`}</title>
                            </circle>
                        )
                )}
            </svg>
            <figcaption>
                <span>{days[0]?.date}</span>
                <span>Reported tokens · gaps have no point</span>
                <span>{days.at(-1)?.date}</span>
            </figcaption>
        </figure>
    );
}
