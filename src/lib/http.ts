/**
 * Expand DKAN-style indexed array params.
 *
 * Converts: { conditions: [{ property: "name", value: "Smith", operator: "=" }] }
 * Into:     { "conditions[0][property]": "name", "conditions[0][value]": "Smith", "conditions[0][operator]": "=" }
 */
export function expandDkanParams(
    params?: Record<string, unknown>,
): Record<string, unknown> | undefined {
    if (!params) return params;

    const expanded: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(params)) {
        if (Array.isArray(value) && value.length > 0 && typeof value[0] === "object") {
            // Expand array of objects into indexed bracket notation
            for (let i = 0; i < value.length; i++) {
                const item = value[i] as Record<string, unknown>;
                for (const [subKey, subVal] of Object.entries(item)) {
                    expanded[`${key}[${i}][${subKey}]`] = subVal;
                }
            }
        } else {
            expanded[key] = value;
        }
    }

    return expanded;
}
