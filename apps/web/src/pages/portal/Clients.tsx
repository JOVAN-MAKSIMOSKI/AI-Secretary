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
  phone: string | null;
  address: string | null;
  notes: string | null;
  created_at: string | null;
};

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
  const [editPhone, setEditPhone] = useState("");
  const [editAddress, setEditAddress] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [submittingEditClient, setSubmittingEditClient] = useState(false);
  const tenantIdentifier = tenantId;
  const isResolvingTenant = appLoading && !tenantIdentifier;

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

    setSubmittingClient(true);
    try {
      const created = await createClientProfile({
        tenant_id: tenantIdentifier,
        name,
        email,
        phone: phone.trim() ? phone : null,
        address: address.trim() ? address : null,
        notes: notes.trim() ? notes : null,
      });

      const data = await getClientsByTenant(tenantIdentifier);
      setClients(data);
      setClientSuccess(`Client ${created.name} created successfully.`);
      setName("");
      setEmail("");
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
        const data = await getClientsByTenant(tenantIdentifier);
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
      await deleteClientById(tenantIdentifier, client.id);
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
      const updated = await updateClientById(tenantIdentifier, editingClientId, {
        name: editName,
        email: editEmail,
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
    <section className="m-2 space-y-5 md:m-3">
      <header>
        <h1 className="text-xl font-semibold text-slate-950">Clients</h1>
        <p className="mt-1 text-sm text-slate-600">All clients under your tenant.</p>
        <p className="mt-2 text-xs uppercase tracking-[0.2em] text-slate-500">
          Tenant ID: <span className="font-mono text-slate-700">{tenantIdentifier ?? "Loading..."}</span>
        </p>
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={() => {
              setClientError("");
              setClientSuccess("");
              setIsDialogOpen(true);
            }}
            disabled={!tenantIdentifier}
            className="inline-flex h-10 items-center justify-center bg-slate-950 px-4 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-70"
          >
            Quick Add Client
          </button>
        </div>
      </header>

      {isDialogOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4">
          <div className="w-full max-w-2xl border border-slate-200 bg-white p-4 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold text-slate-950">Quick Add Client</h2>
                <p className="mt-1 text-[13px] text-slate-600">
                  Create a client without leaving this page.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsDialogOpen(false)}
                className="h-9 border border-slate-300 px-3 text-sm text-slate-700 transition hover:border-slate-900 hover:text-slate-900"
              >
                Close
              </button>
            </div>

            <p className="mb-4 text-[11px] text-slate-500">{userEmail ?? "Unknown"} · {tenantIdentifier ?? "Loading..."}</p>

            <form onSubmit={handleCreateClient} className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <label className="block space-y-2">
                  <span className="text-sm font-medium text-slate-700">Name</span>
                  <input
                    type="text"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    minLength={1}
                    maxLength={120}
                    placeholder="Client name"
                    className="h-11 w-full border border-slate-300 bg-white px-4 text-sm outline-none transition focus:border-slate-900"
                    required
                  />
                </label>

                <label className="block space-y-2">
                  <span className="text-sm font-medium text-slate-700">Email</span>
                  <input
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    minLength={3}
                    maxLength={254}
                    placeholder="client@example.com"
                    className="h-11 w-full border border-slate-300 bg-white px-4 text-sm outline-none transition focus:border-slate-900"
                    required
                  />
                </label>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <label className="block space-y-2">
                  <span className="text-sm font-medium text-slate-700">Phone optional</span>
                  <input
                    type="tel"
                    value={phone}
                    onChange={(event) => setPhone(event.target.value)}
                    maxLength={30}
                    placeholder="+1 555 123 4567"
                    className="h-11 w-full border border-slate-300 bg-white px-4 text-sm outline-none transition focus:border-slate-900"
                  />
                </label>

                <label className="block space-y-2">
                  <span className="text-sm font-medium text-slate-700">Address optional</span>
                  <input
                    type="text"
                    value={address}
                    onChange={(event) => setAddress(event.target.value)}
                    maxLength={255}
                    placeholder="Street, city, country"
                    className="h-11 w-full border border-slate-300 bg-white px-4 text-sm outline-none transition focus:border-slate-900"
                  />
                </label>
              </div>

              <label className="block space-y-2">
                <span className="text-sm font-medium text-slate-700">Notes optional</span>
                <textarea
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  maxLength={1000}
                  rows={3}
                  placeholder="Any context for this client"
                  className="w-full border border-slate-300 bg-white px-4 py-3 text-sm outline-none transition focus:border-slate-900"
                />
              </label>

              {clientError ? (
                <div className="border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                  {clientError}
                </div>
              ) : null}

              {clientSuccess ? (
                <div className="border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
                  {clientSuccess}
                </div>
              ) : null}

              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setIsDialogOpen(false)}
                  className="inline-flex h-11 items-center justify-center border border-slate-300 px-5 text-sm font-medium text-slate-700 transition hover:border-slate-900 hover:text-slate-900"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submittingClient || !tenantIdentifier}
                  className="inline-flex h-11 items-center justify-center bg-slate-950 px-5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {submittingClient ? "Creating client..." : "Create client"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {isEditDialogOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4">
          <div className="w-full max-w-2xl border border-slate-200 bg-white p-4 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold text-slate-950">Edit Client</h2>
                <p className="mt-1 text-[13px] text-slate-600">
                  Update client details without leaving this page.
                </p>
              </div>
              <button
                type="button"
                onClick={closeEditDialog}
                className="h-9 border border-slate-300 px-3 text-sm text-slate-700 transition hover:border-slate-900 hover:text-slate-900"
              >
                Close
              </button>
            </div>

            <p className="mb-4 text-[11px] text-slate-500">{userEmail ?? "Unknown"} · {tenantIdentifier ?? "Loading..."}</p>

            <form onSubmit={handleEditClient} className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <label className="block space-y-2">
                  <span className="text-sm font-medium text-slate-700">Name</span>
                  <input
                    type="text"
                    value={editName}
                    onChange={(event) => setEditName(event.target.value)}
                    minLength={1}
                    maxLength={120}
                    placeholder="Client name"
                    className="h-11 w-full border border-slate-300 bg-white px-4 text-sm outline-none transition focus:border-slate-900"
                    required
                  />
                </label>

                <label className="block space-y-2">
                  <span className="text-sm font-medium text-slate-700">Email</span>
                  <input
                    type="email"
                    value={editEmail}
                    onChange={(event) => setEditEmail(event.target.value)}
                    minLength={3}
                    maxLength={254}
                    placeholder="client@example.com"
                    className="h-11 w-full border border-slate-300 bg-white px-4 text-sm outline-none transition focus:border-slate-900"
                    required
                  />
                </label>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <label className="block space-y-2">
                  <span className="text-sm font-medium text-slate-700">Phone optional</span>
                  <input
                    type="tel"
                    value={editPhone}
                    onChange={(event) => setEditPhone(event.target.value)}
                    maxLength={30}
                    placeholder="+1 555 123 4567"
                    className="h-11 w-full border border-slate-300 bg-white px-4 text-sm outline-none transition focus:border-slate-900"
                  />
                </label>

                <label className="block space-y-2">
                  <span className="text-sm font-medium text-slate-700">Address optional</span>
                  <input
                    type="text"
                    value={editAddress}
                    onChange={(event) => setEditAddress(event.target.value)}
                    maxLength={255}
                    placeholder="Street, city, country"
                    className="h-11 w-full border border-slate-300 bg-white px-4 text-sm outline-none transition focus:border-slate-900"
                  />
                </label>
              </div>

              <label className="block space-y-2">
                <span className="text-sm font-medium text-slate-700">Notes optional</span>
                <textarea
                  value={editNotes}
                  onChange={(event) => setEditNotes(event.target.value)}
                  maxLength={1000}
                  rows={3}
                  placeholder="Any context for this client"
                  className="w-full border border-slate-300 bg-white px-4 py-3 text-sm outline-none transition focus:border-slate-900"
                />
              </label>

              {clientError ? (
                <div className="border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                  {clientError}
                </div>
              ) : null}

              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={closeEditDialog}
                  className="inline-flex h-11 items-center justify-center border border-slate-300 px-5 text-sm font-medium text-slate-700 transition hover:border-slate-900 hover:text-slate-900"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submittingEditClient || !tenantIdentifier || !editingClientId}
                  className="inline-flex h-11 items-center justify-center bg-slate-950 px-5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {submittingEditClient ? "Saving..." : "Save changes"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {isResolvingTenant || loadingClients ? (
        <div className="border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">
          Loading clients...
        </div>
      ) : null}

      {!appLoading && !tenantIdentifier ? (
        <div className="border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
          No business profile was found for this account yet.
        </div>
      ) : null}

      {error ? (
        <div className="border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>
      ) : null}

      {!loadingClients && !error && tenantIdentifier ? (
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_14px_40px_-28px_rgba(15,23,42,0.6)]">
          <div className="flex items-center justify-between border-b border-slate-200 bg-gradient-to-r from-slate-50 to-white px-5 py-4">
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-700">Client Directory</h2>
              <p className="mt-1 text-xs text-slate-500">Manage contacts, details, and onboarding context.</p>
            </div>
            <div className="rounded-full border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-700">
              {clients.length} {clients.length === 1 ? "client" : "clients"}
            </div>
          </div>

          <div className="overflow-x-auto">
            <div className="min-w-[800px]">
              <div className="grid grid-cols-[33%_29%_20%_12%_6%] border-b border-slate-200 bg-slate-50/80 text-left text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                <span className="px-5 py-3">Client</span>
                <span className="px-5 py-3">Email</span>
                <span className="px-5 py-3">Phone</span>
                <span className="px-5 py-3">Added</span>
                <span className="px-5 py-3 text-right">Actions</span>
              </div>

              <div className="max-h-[20rem] overflow-y-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
                {clients.length === 0 ? (
                  <div className="px-5 py-10 text-center text-sm text-slate-500">No clients found for this tenant.</div>
                ) : (
                  clients.map((client) => (
                    <div
                      key={client.id}
                      className="grid h-16 grid-cols-[33%_29%_20%_12%_6%] border-b border-slate-100 text-sm text-slate-800 transition hover:bg-slate-50/70 last:border-b-0"
                    >
                      <div className="px-5 py-4">
                        <div className="flex items-start gap-3">
                          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-slate-300 bg-slate-100 text-xs font-semibold uppercase text-slate-700">
                            {client.name.slice(0, 2)}
                          </span>
                          <div className="min-w-0">
                            <p className="truncate font-semibold text-slate-900">{client.name}</p>
                            <p className="mt-0.5 truncate text-xs text-slate-500">{client.address ?? "No address yet"}</p>
                          </div>
                        </div>
                      </div>

                      <div className="px-5 py-4">
                        <p className="truncate font-medium text-slate-700">{client.email}</p>
                      </div>

                      <div className="px-5 py-4">
                        {client.phone ? (
                          <span className="inline-flex rounded-full border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700">
                            {client.phone}
                          </span>
                        ) : (
                          <span className="text-slate-400">-</span>
                        )}
                      </div>

                      <div className="px-5 py-4 text-slate-500">
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
                            className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-slate-300 bg-white text-slate-600 transition hover:border-slate-900 hover:text-slate-900"
                          >
                            <MoreHorizontal size={15} />
                          </button>
                        </div>

                        {activeMenuClientId === client.id ? (
                          <div data-client-menu className="absolute right-5 top-11 z-20 w-28 rounded-xl border border-slate-200 bg-white p-1.5 shadow-lg">
                            <button
                              type="button"
                              onClick={() => openEditDialog(client)}
                              className="flex w-full items-center justify-start rounded-lg px-2.5 py-2 text-xs font-medium text-slate-700 transition hover:bg-slate-100"
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                void handleDeleteClient(client);
                              }}
                              disabled={deletingClientId === client.id}
                              className="flex w-full items-center justify-start rounded-lg px-2.5 py-2 text-xs font-medium text-rose-700 transition hover:bg-rose-50"
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
