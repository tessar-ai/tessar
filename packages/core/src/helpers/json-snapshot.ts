// Only proven, deeply frozen JSON graphs may be shared or skip later validation.
export const jsonSnapshots = new WeakSet<object>();

// trackJson is only for structuredClone output or projections assembled from owned snapshots.
export function freezeSnapshot<T>(value: T, trackJson: boolean): Readonly<T> {
  if (value && typeof value === "object") {
    if (jsonSnapshots.has(value)) return value as Readonly<T>;
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    let json = trackJson && (array || prototype === Object.prototype || prototype === null);
    for (const child of Object.values(value)) {
      freezeSnapshot(child, trackJson);
      json &&= child === null || typeof child === "string" || typeof child === "boolean"
        || (typeof child === "number" && Number.isFinite(child))
        || (typeof child === "object" && jsonSnapshots.has(child));
    }
    if (json && array)
      for (let index = 0; index < value.length; index++)
        if (!Object.hasOwn(value, index)) { json = false; break; }
    Object.freeze(value);
    if (json) jsonSnapshots.add(value);
  }
  return value as Readonly<T>;
}
