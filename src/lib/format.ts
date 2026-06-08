/** Format a number as INR currency (en-IN). */
export function formatINR(value: number, decimals = 2): string {
  const abs = Math.abs(value);
  const formatted = new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(abs);
  return value < 0 ? `-${formatted}` : formatted;
}

/** Format category slug for display (e.g. rent → Rent). */
export function formatCategoryLabel(category: string): string {
  return category.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Format ISO date for display (e.g. 1 March 2025). */
export function formatDisplayDate(date: string | Date): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}
