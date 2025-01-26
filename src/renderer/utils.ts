
export function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

export function isDate(value: string): boolean {
    const timestamp = Date.parse(value);
    return !isNaN(timestamp);
}

export function hslToHex(h: number, s: number, l: number): string {
    s /= 100;
    l /= 100;
    const k = (n: number) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n: number) =>
        l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    const r = Math.round(255 * f(0));
    const g = Math.round(255 * f(8));
    const b = Math.round(255 * f(4));
    const toHex = (x: number) => x.toString(16).padStart(2, '0');
    return "#" + toHex(r) + toHex(g) + toHex(b);
}

export function htmlElement(
    tag: string,
    content: string = "",
    style: Record<string, string> = {},
    attributes: Record<string, string> = {},
): string {

    let styleStr = ""
    let attributesStr = ""

    if (Object.keys(style).length > 0) {
        styleStr = 'style="' + Object.entries(style).map(([k, v]) => {
            return `${k}: ${v};`
        }).join(' ') + '"'
    }

    if (Object.keys(attributes).length > 0) {
        attributesStr = Object.entries(attributes).map(([k, v]) => {
            return `${k}="${v}"`
        }).join(' ')
    }

    return `<${tag} ${styleStr} ${attributesStr}>${content}</${tag}>`;
}