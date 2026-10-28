/**
 * Phone number with a country picker (every country, with its dial code). The value is always in
 * international form ("+2348031234567"), and the field says live whether the number can exist in that country.
 * The server checks the same rules again and makes sure no other account uses the number.
 */
import { useMemo, useState } from "react";
import { getCountries, getCountryCallingCode, parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js/max";

/** "NG" → 🇳🇬 */
const flag = (cc: string) => String.fromCodePoint(...[...cc].map((c) => 0x1f1a5 + c.charCodeAt(0)));
const names = (() => { try { return new Intl.DisplayNames(["en"], { type: "region" }); } catch { return null; } })();

/** Is this international number real for its country? */
export const phoneValid = (v: string) => Boolean(v && parsePhoneNumberFromString(v)?.isValid());

export function PhoneInput({ value, onChange, className = "", required, id }: { value: string; onChange: (v: string) => void; className?: string; required?: boolean; id?: string }) {
  const countries = useMemo(() => getCountries()
    .map((cc) => ({ cc, name: names?.of(cc) ?? cc, code: getCountryCallingCode(cc) }))
    .sort((a, b) => a.name.localeCompare(b.name)), []);
  // Start from the number's own country, else Nigeria.
  const parsed = value ? parsePhoneNumberFromString(value) : undefined;
  const [cc, setCc] = useState<CountryCode>((parsed?.country as CountryCode) ?? "NG");
  const dial = `+${getCountryCallingCode(cc)}`;
  const local = value.startsWith(dial) ? value.slice(dial.length) : parsed?.nationalNumber ?? value.replace(/^\+/, "");
  const [touched, setTouched] = useState(false);

  /** Typing "0803 123 4567" or "+234 803…" both end up as +234803…; a leading 0 is dropped. */
  const setLocal = (raw: string) => {
    const t = raw.trim();
    if (t.startsWith("+")) {
      const p = parsePhoneNumberFromString(t);
      if (p?.country) setCc(p.country as CountryCode);
      onChange(t.replace(/[^\d+]/g, ""));
      return;
    }
    const digits = t.replace(/\D/g, "").replace(/^0+/, "");
    onChange(digits ? `${dial}${digits}` : "");
  };
  const ok = phoneValid(value);
  const showError = touched && value && !ok;
  return (
    <div>
      <div className={`flex overflow-hidden rounded-xl border bg-stone-50 transition focus-within:bg-white focus-within:ring-4 focus-within:ring-brand-500/10 ${showError ? "border-red-400" : ok ? "border-brand-400" : "border-stone-200 focus-within:border-brand-500"} ${className}`}>
        <div className="relative flex shrink-0 items-center border-r border-stone-200 pl-3 pr-2 text-[15px]">
          <span aria-hidden="true">{flag(cc)} {dial}</span>
          <span className="ml-1 text-xs text-stone-400" aria-hidden="true">▾</span>
          <select aria-label="Country" value={cc} onChange={(e) => { const n = e.target.value as CountryCode; setCc(n); onChange(local ? `+${getCountryCallingCode(n)}${local}` : ""); }}
            className="absolute inset-0 cursor-pointer opacity-0">
            {countries.map((c) => <option key={c.cc} value={c.cc}>{c.name} (+{c.code})</option>)}
          </select>
        </div>
        <input id={id} type="tel" inputMode="tel" autoComplete="tel-national" required={required} value={local} placeholder="803 123 4567" aria-label="Phone number"
          onChange={(e) => setLocal(e.target.value)} onBlur={() => setTouched(true)}
          className="min-w-0 flex-1 bg-transparent px-3 py-3 text-[15px] outline-none placeholder:text-stone-400" />
        {ok && <span className="flex items-center pr-3 text-brand-600" aria-label="Valid number">✓</span>}
      </div>
      {showError && <p className="mt-1 text-xs text-red-600">That number can't exist in {names?.of(cc) ?? cc}. Check it and the country.</p>}
    </div>
  );
}
