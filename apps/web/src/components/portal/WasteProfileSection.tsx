import { useCallback, useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  getUserBusiness,
  updateBusinessProfile,
  type BusinessProfileResponse,
  type TenantWasteProfile,
} from "../../connection/supabase-client";

// Waste-law advisor profile form (Phase 2 of the waste-law RAG plan).
// Structured dropdowns only — the selections are stored as JSONB and formatted
// straight into the legal advisor's LLM prompt, so no free-text parsing is needed.

const ENTITY_TYPE_OPTIONS = [
  { value: "individual", label: "Individual" },
  { value: "small_business", label: "Small Business" },
  { value: "large_company", label: "Large Company" },
  { value: "municipality", label: "Municipality" },
] as const;

const WASTE_TYPE_OPTIONS = [
  { value: "hazardous_waste", label: "Опасен отпад (Hazardous waste)" },
  { value: "oils_tires", label: "Отпад на масла и гуми (Oil and tire waste)" },
  { value: "textile_paper", label: "Текстил и хартија (Textile and paper)" },
  { value: "glass", label: "Стакло (Glass)" },
  { value: "plastic", label: "Пластика (Plastic)" },
  { value: "other", label: "Друго (Other)" },
] as const;

const ANNUAL_VOLUME_OPTIONS = [
  { value: "under_200kg", label: "Under 200 kg" },
  { value: "200kg_5t", label: "200 kg – 5 tons" },
  { value: "5t_plus", label: "Over 5 tons" },
] as const;

// Empty string = "not selected" in the form; mapped to null on submit
const wasteProfileFormSchema = z.object({
  entity_type: z.enum(["", "individual", "small_business", "large_company", "municipality"]),
  waste_types: z.array(
    z.enum(["hazardous_waste", "oils_tires", "textile_paper", "glass", "plastic", "other"])
  ),
  annual_volume: z.enum(["", "under_200kg", "200kg_5t", "5t_plus"]),
  location: z.string().max(120),
  has_permits: z.boolean(),
  permit_types: z.string().max(500),
  // Real businesses columns (not part of tenantprofilecontext JSONB) — stored as
  // text to preserve leading zeros / separators in official permit numbers.
  dangerous_waste_permit_number: z.string().max(60),
  permit_number: z.string().max(60),
});

type WasteProfileFormValues = z.infer<typeof wasteProfileFormSchema>;

const EMPTY_FORM: WasteProfileFormValues = {
  entity_type: "",
  waste_types: [],
  annual_volume: "",
  location: "",
  has_permits: false,
  permit_types: "",
  dangerous_waste_permit_number: "",
  permit_number: "",
};

// The permit numbers are top-level businesses columns, so they come from the
// business response, not the tenantprofilecontext blob.
function businessToFormValues(business: BusinessProfileResponse | null): WasteProfileFormValues {
  const profile = business?.tenantprofilecontext ?? null;
  return {
    entity_type: profile?.entity_type ?? "",
    waste_types: profile?.waste_types ?? [],
    annual_volume: profile?.annual_volume ?? "",
    location: profile?.location ?? "",
    has_permits: profile?.has_permits ?? false,
    permit_types: (profile?.permit_types ?? []).join(", "),
    dangerous_waste_permit_number: business?.dangerous_waste_permit_number ?? "",
    permit_number: business?.permit_number ?? "",
  };
}

function formValuesToProfile(values: WasteProfileFormValues): TenantWasteProfile {
  return {
    entity_type: values.entity_type || null,
    waste_types: values.waste_types,
    annual_volume: values.annual_volume || null,
    location: values.location.trim() || null,
    has_permits: values.has_permits,
    permit_types: values.has_permits
      ? values.permit_types.split(",").map((p) => p.trim()).filter(Boolean)
      : [],
  };
}

const selectClasses =
  "mt-1 w-full rounded-md border border-[var(--brand-border)] bg-white px-3 py-2 text-sm text-[var(--brand-ink)] outline-none transition focus:border-[var(--brand-teal)]";
const labelClasses = "text-sm font-medium text-[var(--brand-ink)]";

export default function WasteProfileSection() {
  const [isLoading, setIsLoading] = useState(true);
  const [banner, setBanner] = useState<{ tone: "success" | "error"; message: string } | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    watch,
    formState: { isSubmitting, isDirty },
  } = useForm<WasteProfileFormValues>({
    resolver: zodResolver(wasteProfileFormSchema),
    defaultValues: EMPTY_FORM,
  });

  const hasPermits = watch("has_permits");

  const loadProfile = useCallback(async () => {
    setIsLoading(true);
    try {
      const business = await getUserBusiness();
      reset(businessToFormValues(business));
    } catch (error) {
      setBanner({
        tone: "error",
        message: error instanceof Error ? error.message : "Failed to load waste profile.",
      });
    } finally {
      setIsLoading(false);
    }
  }, [reset]);

  // Fetch-on-mount, matching the loadStatus pattern used elsewhere on this page
  useEffect(() => {
    void loadProfile();
  }, [loadProfile]);

  const onSubmit = async (values: WasteProfileFormValues) => {
    setBanner(null);
    try {
      const updated = await updateBusinessProfile({
        tenantprofilecontext: formValuesToProfile(values),
        dangerous_waste_permit_number: values.dangerous_waste_permit_number.trim() || null,
        permit_number: values.permit_number.trim() || null,
      });
      reset(businessToFormValues(updated));
      setBanner({ tone: "success", message: "Waste profile saved." });
    } catch (error) {
      setBanner({
        tone: "error",
        message: error instanceof Error ? error.message : "Failed to save waste profile.",
      });
    }
  };

  return (
    <div className="mt-6 rounded-xl border border-[var(--brand-border)] bg-white p-6 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--brand-text-muted)]">Settings</p>
      <h2 className="mt-3 text-2xl font-semibold text-[var(--brand-ink)]">Business Waste Profile</h2>
      <p className="mt-2 text-sm text-[var(--brand-text-muted)]">
        Used by the law questions assistant to give advice specific to your business instead of generic summaries.
      </p>

      {banner ? (
        <div
          className={`mt-4 rounded-lg border px-4 py-3 text-sm ${
            banner.tone === "success"
              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
              : "border-rose-200 bg-rose-50 text-rose-700"
          }`}
        >
          {banner.message}
        </div>
      ) : null}

      {isLoading ? (
        <p className="mt-6 text-sm text-[var(--brand-text-muted)]">Loading profile…</p>
      ) : (
        <form onSubmit={handleSubmit(onSubmit)} className="mt-6 space-y-5">
          <div className="grid gap-5 md:grid-cols-2">
            <div>
              <label className={labelClasses} htmlFor="entity_type">Entity type</label>
              <select id="entity_type" {...register("entity_type")} className={selectClasses}>
                <option value="">Not selected</option>
                {ENTITY_TYPE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>

            <div>
              <label className={labelClasses} htmlFor="annual_volume">Annual waste volume</label>
              <select id="annual_volume" {...register("annual_volume")} className={selectClasses}>
                <option value="">Not selected</option>
                {ANNUAL_VOLUME_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>

            <div>
              <label className={labelClasses} htmlFor="location">Location (municipality)</label>
              <input
                id="location"
                type="text"
                maxLength={120}
                placeholder="e.g. Skopje"
                {...register("location")}
                className={selectClasses}
              />
            </div>

            <div>
              <label className={labelClasses} htmlFor="permit_number">Permit number</label>
              <input
                id="permit_number"
                type="text"
                maxLength={60}
                placeholder="e.g. 00123 or MK-2024/551"
                {...register("permit_number")}
                className={selectClasses}
              />
            </div>

            <div>
              <label className={labelClasses} htmlFor="dangerous_waste_permit_number">
                Dangerous waste permit number
              </label>
              <input
                id="dangerous_waste_permit_number"
                type="text"
                maxLength={60}
                placeholder="e.g. 00456 or MK-2024/778"
                {...register("dangerous_waste_permit_number")}
                className={selectClasses}
              />
            </div>
          </div>

          <fieldset>
            <legend className={labelClasses}>Waste types generated</legend>
            <div className="mt-2 grid gap-2 sm:grid-cols-2 md:grid-cols-3">
              {WASTE_TYPE_OPTIONS.map((o) => (
                <label
                  key={o.value}
                  className="flex items-center gap-2 rounded-lg border border-[var(--brand-border)] bg-[var(--brand-surface)] px-3 py-2 text-sm text-[var(--brand-ink)] transition hover:border-[var(--brand-teal)]"
                >
                  <input
                    type="checkbox"
                    value={o.value}
                    {...register("waste_types")}
                    className="h-4 w-4 accent-[var(--brand-teal)]"
                  />
                  {o.label}
                </label>
              ))}
            </div>
          </fieldset>

          <div>
            <label className="flex items-center gap-2 text-sm font-medium text-[var(--brand-ink)]">
              <input
                type="checkbox"
                {...register("has_permits")}
                className="h-4 w-4 accent-[var(--brand-teal)]"
              />
              Already holds waste-related permits
            </label>

            {hasPermits ? (
              <div className="mt-3">
                <label className={labelClasses} htmlFor="permit_types">Permit types held</label>
                <input
                  id="permit_types"
                  type="text"
                  maxLength={500}
                  placeholder="Comma-separated, e.g. collection permit, transport permit"
                  {...register("permit_types")}
                  className={selectClasses}
                />
              </div>
            ) : null}
          </div>

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={isSubmitting || !isDirty}
              className="rounded-md bg-[var(--brand-teal)] px-4 py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSubmitting ? "Saving…" : "Save waste profile"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
