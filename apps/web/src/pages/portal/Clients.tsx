import { useEffect, useState } from "react";
import {
  createClientProfile,
  deleteClientById,
  getClientsByTenant,
  updateClientById,
} from "../../connection/supabase-client";
import { useAppContextStore } from "../../store/app-context";
import { useSessionStore } from "../../store/session";
import { MoreHorizontal } from "lucide-react";

type ClientRow = {
  id: string;
  name: string;
  email: string;
  city: string | null;
  tax_number: string | null;
  phone: string | null;
  address: string | null;
  notes: string | null;
  created_at: string | null;
};

function normalizeClientName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export default function Clients() {
  const tenantId = useSessionStore((state) => state.tenantId);
  const userEmail = useAppContextStore((state) => state.userEmail);
  const appLoading = useAppContextStore((state) => state.loading);
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [loadingClients, setLoadingClients] = useState(false);
  const [error, setError] = useState("");
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [city, setCity] = useState("");
  const [taxNumber, setTaxNumber] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [notes, setNotes] = useState("");
  const [submittingClient, setSubmittingClient] = useState(false);
  const [clientError, setClientError] = useState("");
  const [clientSuccess, setClientSuccess] = useState("");
  const [activeMenuClientId, setActiveMenuClientId] = useState<string | null>(null);
  const [deletingClientId, setDeletingClientId] = useState<string | null>(null);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [editingClientId, setEditingClientId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [editCity, setEditCity] = useState("");
  const [editTaxNumber, setEditTaxNumber] = useState("");
  const [editPhone, setEditPhone] = useState("");
  const [editAddress, setEditAddress] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [submittingEditClient, setSubmittingEditClient] = useState(false);
  const tenantIdentifier = tenantId;
  const isResolvingTenant = appLoading && !tenantIdentifier;
  const normalizedInputName = normalizeClientName(name);
  const duplicateNameExists = clients.some(
    (client) => normalizeClientName(client.name) === normalizedInputName
  );

  useEffect(() => {
    const closeMenuOnOutsideClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) {
        return;
      }

      if (target.closest("[data-client-menu]") || target.closest("[data-client-menu-trigger]")) {
        return;
      }

      setActiveMenuClientId(null);
    };

    document.addEventListener("mousedown", closeMenuOnOutsideClick);

    return () => {
      document.removeEventListener("mousedown", closeMenuOnOutsideClick);
    };
  }, []);

  const handleCreateClient = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setClientError("");
    setClientSuccess("");

    if (!tenantIdentifier) {
      setClientError("Tenant ID is still loading. Try again in a moment.");
      return;
    }

    if (duplicateNameExists) {
      setClientError("A client with the same name already exists for this tenant.");
      return;
    }

    setSubmittingClient(true);
    try {
      const created = await createClientProfile({
        name,
        email,
        city: city.trim() ? city.trim() : null,
        tax_number: taxNumber.trim() ? taxNumber.trim() : null,
        phone: phone.trim() ? phone : null,
        address: address.trim() ? address : null,
        notes: notes.trim() ? notes : null,
      });

      const data = await getClientsByTenant();
      setClients(data);
      setClientSuccess(`Client ${created.name} created successfully.`);
      setName("");
      setEmail("");
      setCity("");
      setTaxNumber("");
      setPhone("");
      setAddress("");
      setNotes("");
    } catch (createError) {
      setClientError((createError as Error).message);
    } finally {
      setSubmittingClient(false);
    }
  };

  useEffect(() => {
    if (!tenantIdentifier) {
      setClients([]);
      return;
    }

    let isMounted = true;

    const loadClients = async () => {
      setLoadingClients(true);
      setError("");
      try {
        const data = await getClientsByTenant();
        if (isMounted) {
          setClients(data);
        }
      } catch (fetchError) {
        if (isMounted) {
          setError((fetchError as Error).message);
          setClients([]);
        }
      } finally {
        if (isMounted) {
          setLoadingClients(false);
        }
      }
    };

    void loadClients();

    return () => {
      isMounted = false;
    };
  }, [tenantIdentifier]);

  const handleDeleteClient = async (client: ClientRow) => {
    if (!tenantIdentifier || deletingClientId) {
      return;
    }

    const confirmed = window.confirm(`Delete client \"${client.name}\"? This action cannot be undone.`);
    if (!confirmed) {
      return;
    }

    setClientError("");
    setClientSuccess("");
    setDeletingClientId(client.id);

    try {
      await deleteClientById(client.id);
      setClients((current) => current.filter((item) => item.id !== client.id));
      setClientSuccess(`Client ${client.name} deleted.`);
      setActiveMenuClientId(null);
    } catch (deleteError) {
      setClientError((deleteError as Error).message);
    } finally {
      setDeletingClientId(null);
    }
  };

  const openEditDialog = (client: ClientRow) => {
    setClientError("");
    setClientSuccess("");
    setActiveMenuClientId(null);
    setEditingClientId(client.id);
    setEditName(client.name);
    setEditEmail(client.email);
    setEditCity(client.city ?? "");
    setEditTaxNumber(client.tax_number ?? "");
    setEditPhone(client.phone ?? "");
    setEditAddress(client.address ?? "");
    setEditNotes(client.notes ?? "");
    setIsEditDialogOpen(true);
  };

  const closeEditDialog = () => {
    if (submittingEditClient) {
      return;
    }
    setIsEditDialogOpen(false);
    setEditingClientId(null);
  };

  const handleEditClient = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!tenantIdentifier || !editingClientId) {
      setClientError("Unable to update client right now. Try again.");
      return;
    }

    setClientError("");
    setClientSuccess("");
    setSubmittingEditClient(true);

    try {
      const updated = await updateClientById(editingClientId, {
        name: editName,
        email: editEmail,
        city: editCity.trim() ? editCity.trim() : null,
        tax_number: editTaxNumber.trim() ? editTaxNumber.trim() : null,
        phone: editPhone.trim() ? editPhone : null,
        address: editAddress.trim() ? editAddress : null,
        notes: editNotes.trim() ? editNotes : null,
      });

      setClients((current) =>
        current.map((client) => (client.id === updated.id ? ({ ...client, ...updated } as ClientRow) : client))
      );
      setClientSuccess(`Client ${updated.name} updated successfully.`);
      setIsEditDialogOpen(false);
      setEditingClientId(null);
    } catch (updateError) {
      setClientError((updateError as Error).message);
    } finally {
      setSubmittingEditClient(false);
    }
  };

  return (
    <section className="m-2 space-y-5 text-[var(--brand-ink)] md:m-3">
      <header>
        <h1 className="text-xl font-medium tracking-[-0.01em] text-[var(--brand-ink)]">Clients</h1>
        <p className="mt-1 text-sm text-[var(--brand-text-muted)]">All clients under your tenant.</p>
        
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={() => {
              setClientError("");
              setClientSuccess("");
              setIsDialogOpen(true);
            }}
            disabled={!tenantIdentifier}
            className="inline-flex h-10 items-center justify-center rounded-full bg-[var(--brand-teal)] px-4 text-sm font-medium text-white transition hover:bg-[#2f8575] disabled:cursor-not-allowed disabled:opacity-70"
          >
            Quick Add Client
          </button>
        </div>
      </header>

      {isDialogOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(15,25,35,0.45)] p-4">
          <div className="w-full max-w-2xl rounded-xl border border-[var(--brand-border)] bg-[var(--brand-card)] p-4 shadow-xl shadow-slate-900/20">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-medium text-[var(--brand-ink)]">Quick Add Client</h2>
                <p className="mt-1 text-[13px] text-[var(--brand-text-muted)]">
                  Create a client without leaving this page.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsDialogOpen(false)}
                className="h-9 rounded-md border border-[var(--brand-border)] px-3 text-sm text-[var(--brand-text-muted)] transition hover:border-[var(--brand-teal)] hover:text-[var(--brand-teal)]"
              >
                Close
              </button>
            </div>

            <p className="mb-4 text-[11px] text-[var(--brand-text-muted)]">{userEmail ?? "Unknown"} · {tenantIdentifier ?? "Loading..."}</p>

            <form onSubmit={handleCreateClient} className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <label className="block space-y-2">
                  <span className="text-sm font-medium text-[var(--brand-ink)]">Name</span>
                  <input
                    type="text"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    minLength={1}
                    maxLength={120}
                    placeholder="Client name"
                    className="h-11 w-full rounded-lg border border-[var(--brand-border)] bg-[var(--brand-surface)] px-4 text-sm outline-none transition focus:border-[var(--brand-teal)] focus:bg-white"
                    required
                  />
                </label>

                <label className="block space-y-2">
                  <span className="text-sm font-medium text-[var(--brand-ink)]">Email</span>
                  <input
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    minLength={3}
                    maxLength={254}
                    placeholder="client@example.com"
                    className="h-11 w-full rounded-lg border border-[var(--brand-border)] bg-[var(--brand-surface)] px-4 text-sm outline-none transition focus:border-[var(--brand-teal)] focus:bg-white"
                    required
                  />
                </label>

                <label className="block space-y-2">
                  <span className="text-sm font-medium text-[var(--brand-ink)]">Tax number</span>
                  <input
                    type="text"
                    value={taxNumber}
                    onChange={(event) => setTaxNumber(event.target.value)}
                    maxLength={60}
                    placeholder="PIB / VAT / Tax ID"
                    className="h-11 w-full rounded-lg border border-[var(--brand-border)] bg-[var(--brand-surface)] px-4 text-sm outline-none transition focus:border-[var(--brand-teal)] focus:bg-white"
                    required
                  />
                </label>

                <label className="block space-y-2">
                  <span className="text-sm font-medium text-[var(--brand-ink)]">City</span>
                  <input
                    type="text"
                    value={city}
                    onChange={(event) => setCity(event.target.value)}
                    maxLength={120}
                    placeholder="Belgrade"
                    className="h-11 w-full rounded-lg border border-[var(--brand-border)] bg-[var(--brand-surface)] px-4 text-sm outline-none transition focus:border-[var(--brand-teal)] focus:bg-white"
                    required
                  />
                </label>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <label className="block space-y-2">
                  <span className="text-sm font-medium text-[var(--brand-ink)]">Phone optional</span>
                  <input
                    type="tel"
                    value={phone}
                    onChange={(event) => setPhone(event.target.value)}
                    maxLength={30}
                    placeholder="+1 555 123 4567"
                    className="h-11 w-full rounded-lg border border-[var(--brand-border)] bg-[var(--brand-surface)] px-4 text-sm outline-none transition focus:border-[var(--brand-teal)] focus:bg-white"
                  />
                </label>

                <label className="block space-y-2">
                  <span className="text-sm font-medium text-[var(--brand-ink)]">Address optional</span>
                  <input
                    type="text"
                    value={address}
                    onChange={(event) => setAddress(event.target.value)}
                    maxLength={255}
                    placeholder="Street, city, country"
                    className="h-11 w-full rounded-lg border border-[var(--brand-border)] bg-[var(--brand-surface)] px-4 text-sm outline-none transition focus:border-[var(--brand-teal)] focus:bg-white"
                  />
                </label>
              </div>

              <label className="block space-y-2">
                <span className="text-sm font-medium text-[var(--brand-ink)]">Notes optional</span>
                <textarea
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  maxLength={1000}
                  rows={3}
                  placeholder="Any context for this client"
                  className="w-full rounded-lg border border-[var(--brand-border)] bg-[var(--brand-surface)] px-4 py-3 text-sm outline-none transition focus:border-[var(--brand-teal)] focus:bg-white"
                />
              </label>

              {clientError ? (
                <div className="rounded-lg border border-[#f7cccc] bg-[var(--brand-danger-bg)] px-4 py-3 text-sm text-[var(--brand-danger-text)]">
                  {clientError}
                </div>
              ) : null}

              {!clientError && duplicateNameExists ? (
                <div className="rounded-lg border border-[#f7e0b6] bg-[var(--brand-warning-bg)] px-4 py-3 text-sm text-[var(--brand-warning-text)]">
                  A client with this name already exists for this tenant.
                </div>
              ) : null}

              {clientSuccess ? (
                <div className="rounded-lg border border-[#cdeade] bg-[var(--brand-teal-soft)] px-4 py-3 text-sm text-[#1a6b5a]">
                  {clientSuccess}
                </div>
              ) : null}

              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setIsDialogOpen(false)}
                  className="inline-flex h-11 items-center justify-center rounded-lg border border-[var(--brand-border)] px-5 text-sm font-medium text-[var(--brand-text-muted)] transition hover:border-[var(--brand-teal)] hover:text-[var(--brand-teal)]"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submittingClient || !tenantIdentifier || duplicateNameExists}
                  className="inline-flex h-11 items-center justify-center rounded-lg bg-[var(--brand-teal)] px-5 text-sm font-medium text-white transition hover:bg-[#2f8575] disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {submittingClient ? "Creating client..." : "Create client"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {isEditDialogOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(15,25,35,0.45)] p-4">
          <div className="w-full max-w-2xl rounded-xl border border-[var(--brand-border)] bg-[var(--brand-card)] p-4 shadow-xl shadow-slate-900/20">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-medium text-[var(--brand-ink)]">Edit Client</h2>
                <p className="mt-1 text-[13px] text-[var(--brand-text-muted)]">
                  Update client details without leaving this page.
                </p>
              </div>
              <button
                type="button"
                onClick={closeEditDialog}
                className="h-9 rounded-md border border-[var(--brand-border)] px-3 text-sm text-[var(--brand-text-muted)] transition hover:border-[var(--brand-teal)] hover:text-[var(--brand-teal)]"
              >
                Close
              </button>
            </div>

            <p className="mb-4 text-[11px] text-[var(--brand-text-muted)]">{userEmail ?? "Unknown"} · {tenantIdentifier ?? "Loading..."}</p>

            <form onSubmit={handleEditClient} className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <label className="block space-y-2">
                  <span className="text-sm font-medium text-[var(--brand-ink)]">Name</span>
                  <input
                    type="text"
                    value={editName}
                    onChange={(event) => setEditName(event.target.value)}
                    minLength={1}
                    maxLength={120}
                    placeholder="Client name"
                    className="h-11 w-full rounded-lg border border-[var(--brand-border)] bg-[var(--brand-surface)] px-4 text-sm outline-none transition focus:border-[var(--brand-teal)] focus:bg-white"
                    required
                  />
                </label>

                <label className="block space-y-2">
                  <span className="text-sm font-medium text-[var(--brand-ink)]">Email</span>
                  <input
                    type="email"
                    value={editEmail}
                    onChange={(event) => setEditEmail(event.target.value)}
                    minLength={3}
                    maxLength={254}
                    placeholder="client@example.com"
                    className="h-11 w-full rounded-lg border border-[var(--brand-border)] bg-[var(--brand-surface)] px-4 text-sm outline-none transition focus:border-[var(--brand-teal)] focus:bg-white"
                    required
                  />
                </label>

                <label className="block space-y-2">
                  <span className="text-sm font-medium text-[var(--brand-ink)]">Tax number</span>
                  <input
                    type="text"
                    value={editTaxNumber}
                    onChange={(event) => setEditTaxNumber(event.target.value)}
                    maxLength={60}
                    placeholder="PIB / VAT / Tax ID"
                    className="h-11 w-full rounded-lg border border-[var(--brand-border)] bg-[var(--brand-surface)] px-4 text-sm outline-none transition focus:border-[var(--brand-teal)] focus:bg-white"
                    required
                  />
                </label>

                <label className="block space-y-2">
                  <span className="text-sm font-medium text-[var(--brand-ink)]">City</span>
                  <input
                    type="text"
                    value={editCity}
                    onChange={(event) => setEditCity(event.target.value)}
                    maxLength={120}
                    placeholder="Belgrade"
                    className="h-11 w-full rounded-lg border border-[var(--brand-border)] bg-[var(--brand-surface)] px-4 text-sm outline-none transition focus:border-[var(--brand-teal)] focus:bg-white"
                    required
                  />
                </label>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <label className="block space-y-2">
                  <span className="text-sm font-medium text-[var(--brand-ink)]">Phone optional</span>
                  <input
                    type="tel"
                    value={editPhone}
                    onChange={(event) => setEditPhone(event.target.value)}
                    maxLength={30}
                    placeholder="+1 555 123 4567"
                    className="h-11 w-full rounded-lg border border-[var(--brand-border)] bg-[var(--brand-surface)] px-4 text-sm outline-none transition focus:border-[var(--brand-teal)] focus:bg-white"
                  />
                </label>

                <label className="block space-y-2">
                  <span className="text-sm font-medium text-[var(--brand-ink)]">Address optional</span>
                  <input
                    type="text"
                    value={editAddress}
                    onChange={(event) => setEditAddress(event.target.value)}
                    maxLength={255}
                    placeholder="Street, city, country"
                    className="h-11 w-full rounded-lg border border-[var(--brand-border)] bg-[var(--brand-surface)] px-4 text-sm outline-none transition focus:border-[var(--brand-teal)] focus:bg-white"
                  />
                </label>
              </div>

              <label className="block space-y-2">
                <span className="text-sm font-medium text-[var(--brand-ink)]">Notes optional</span>
                <textarea
                  value={editNotes}
                  onChange={(event) => setEditNotes(event.target.value)}
                  maxLength={1000}
                  rows={3}
                  placeholder="Any context for this client"
                  className="w-full rounded-lg border border-[var(--brand-border)] bg-[var(--brand-surface)] px-4 py-3 text-sm outline-none transition focus:border-[var(--brand-teal)] focus:bg-white"
                />
              </label>

              {clientError ? (
                <div className="rounded-lg border border-[#f7cccc] bg-[var(--brand-danger-bg)] px-4 py-3 text-sm text-[var(--brand-danger-text)]">
                  {clientError}
                </div>
              ) : null}

              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={closeEditDialog}
                  className="inline-flex h-11 items-center justify-center rounded-lg border border-[var(--brand-border)] px-5 text-sm font-medium text-[var(--brand-text-muted)] transition hover:border-[var(--brand-teal)] hover:text-[var(--brand-teal)]"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submittingEditClient || !tenantIdentifier || !editingClientId}
                  className="inline-flex h-11 items-center justify-center rounded-lg bg-[var(--brand-teal)] px-5 text-sm font-medium text-white transition hover:bg-[#2f8575] disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {submittingEditClient ? "Saving..." : "Save changes"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {isResolvingTenant || loadingClients ? (
        <div className="rounded-lg border border-[var(--brand-border)] bg-[var(--brand-card)] px-4 py-3 text-sm text-[var(--brand-text-muted)]">
          Loading clients...
        </div>
      ) : null}

      {!appLoading && !tenantIdentifier ? (
        <div className="rounded-lg border border-[#f7e0b6] bg-[var(--brand-warning-bg)] px-4 py-3 text-sm text-[var(--brand-warning-text)]">
          No business profile was found for this account yet.
        </div>
      ) : null}

      {error ? (
        <div className="rounded-lg border border-[#f7cccc] bg-[var(--brand-danger-bg)] px-4 py-3 text-sm text-[var(--brand-danger-text)]">{error}</div>
      ) : null}

      {!loadingClients && !error && tenantIdentifier ? (
        <div className="overflow-hidden rounded-xl border border-[var(--brand-border)] bg-[var(--brand-card)] shadow-sm shadow-slate-200/50">
          <div className="flex items-center justify-between border-b border-[var(--brand-border)] bg-[var(--brand-surface)] px-5 py-4">
            <div>
              <h2 className="text-sm font-medium uppercase tracking-[0.14em] text-[var(--brand-ink)]">Client Directory</h2>
              <p className="mt-1 text-xs text-[var(--brand-text-muted)]">Manage contacts, details, and onboarding context.</p>
            </div>
            <div className="rounded-full border border-[var(--brand-border)] bg-[var(--brand-card)] px-3 py-1 text-xs font-medium text-[var(--brand-text-muted)]">
              {clients.length} {clients.length === 1 ? "client" : "clients"}
            </div>
          </div>

          <div className="overflow-x-auto">
            <div className="min-w-[920px]">
              <div className="grid grid-cols-[27%_23%_18%_14%_12%_6%] border-b border-[var(--brand-border)] bg-[#f9fbfc] text-left text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--brand-text-muted)]">
                <span className="px-5 py-3">Client</span>
                <span className="px-5 py-3">Email</span>
                <span className="px-5 py-3">City</span>
                <span className="px-5 py-3">Phone</span>
                <span className="px-5 py-3">Added</span>
                <span className="px-5 py-3 text-right">Actions</span>
              </div>

              <div className="max-h-[20rem] overflow-y-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
                {clients.length === 0 ? (
                  <div className="px-5 py-10 text-center text-sm text-[var(--brand-text-muted)]">No clients found for this tenant.</div>
                ) : (
                  clients.map((client) => (
                    <div
                      key={client.id}
                      className="grid h-16 grid-cols-[27%_23%_18%_14%_12%_6%] border-b border-[#eef2f4] text-sm text-[var(--brand-ink)] transition hover:bg-[var(--brand-surface)]/80 last:border-b-0"
                    >
                      <div className="px-5 py-4">
                        <div className="flex items-start gap-3">
                          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[#cdeade] bg-[var(--brand-teal-soft)] text-xs font-semibold uppercase text-[#1a6b5a]">
                            {client.name.slice(0, 2)}
                          </span>
                          <div className="min-w-0">
                            <p className="truncate font-medium text-[var(--brand-ink)]">{client.name}</p>
                          </div>
                        </div>
                      </div>

                      <div className="px-5 py-4">
                        <p className="truncate font-medium text-[var(--brand-ink)]">{client.email}</p>
                      </div>

                      <div className="px-5 py-4 text-[var(--brand-text-muted)]">
                        {client.city ?? "-"}
                      </div>

                      <div className="px-5 py-4">
                        {client.phone ? (
                          <span className="inline-flex rounded-full border border-[var(--brand-border)] bg-[var(--brand-card)] px-2.5 py-1 text-xs font-medium text-[var(--brand-text-muted)]">
                            {client.phone}
                          </span>
                        ) : (
                          <span className="text-[#a3afbd]">-</span>
                        )}
                      </div>

                      <div className="px-5 py-4 text-[var(--brand-text-muted)]">
                        {client.created_at ? new Date(client.created_at).toLocaleDateString() : "-"}
                      </div>

                      <div className="relative px-5 py-3">
                        <div className="flex justify-end">
                          <button
                            type="button"
                            data-client-menu-trigger
                            aria-haspopup="menu"
                            aria-expanded={activeMenuClientId === client.id}
                            onClick={() => {
                              setActiveMenuClientId((current) => (current === client.id ? null : client.id));
                            }}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-[var(--brand-border)] bg-[var(--brand-card)] text-[var(--brand-text-muted)] transition hover:border-[var(--brand-teal)] hover:text-[var(--brand-teal)]"
                          >
                            <MoreHorizontal size={15} />
                          </button>
                        </div>

                        {activeMenuClientId === client.id ? (
                          <div data-client-menu className="absolute right-5 top-11 z-20 w-28 rounded-lg border border-[var(--brand-border)] bg-[var(--brand-card)] p-1.5 shadow-lg shadow-slate-200/60">
                            <button
                              type="button"
                              onClick={() => openEditDialog(client)}
                              className="flex w-full items-center justify-start rounded-md px-2.5 py-2 text-xs font-medium text-[var(--brand-ink)] transition hover:bg-[var(--brand-surface)]"
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                void handleDeleteClient(client);
                              }}
                              disabled={deletingClientId === client.id}
                              className="flex w-full items-center justify-start rounded-md px-2.5 py-2 text-xs font-medium text-[var(--brand-danger-text)] transition hover:bg-[var(--brand-danger-bg)]"
                            >
                              {deletingClientId === client.id ? "Deleting..." : "Delete"}
                            </button>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
