import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  createFirmProfile,
  createDisposalPlace,
  createContact,
  deleteFirmById,
  deleteDisposalPlaceById,
  deleteContactById,
  getFirmsByTenant,
  getDisposalPlacesByTenant,
  getContactsByTenant,
  updateFirmById,
  updateDisposalPlaceById,
  updateContactById,
  type DisposalPlaceResponse,
  type ContactResponse,
} from "../../connection/supabase-client";
import { useAppContextStore } from "../../store/app-context";
import { useSessionStore } from "../../store/session";
import { ChevronsUpDown, MoreHorizontal } from "lucide-react";

type ClientRow = {
  id: string;
  name: string;
  email: string;
  city: string | null;
  tax_number: string | null;
  phone: string | null;
  address: string | null;
  notes: string | null;
  permit_number: string | null;
  created_at: string | null;
};

type DisposalPlaceRow = DisposalPlaceResponse;
type ContactRow = ContactResponse;

// Which directory is currently visible — only one table renders at a time.
type PartiesTab = "firms" | "disposal" | "contacts";

const PARTIES_TABS: ReadonlyArray<{ id: PartiesTab; label: string }> = [
  { id: "firms", label: "Firms" },
  { id: "disposal", label: "Disposal Places" },
  { id: "contacts", label: "Contacts" },
];

const DEFAULT_PARTIES_TAB: PartiesTab = "firms";

// Coerce an arbitrary ?tab= value to a known tab, defaulting when unknown/absent.
function parsePartiesTab(value: string | null): PartiesTab {
  return PARTIES_TABS.some((tab) => tab.id === value) ? (value as PartiesTab) : DEFAULT_PARTIES_TAB;
}

const EMPTY_DISPOSAL_FORM = {
  name: "",
  address: "",
  place: "",
  email: "",
  phone_number: "",
};

const EMPTY_CONTACT_FORM = {
  firm_id: "",
  name: "",
  email: "",
  phone_number: "",
  address: "",
};

function normalizeClientName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

// Column header cell for the directory tables. Renders the label with a subtle
// sort chevron so the header reads like the reference design. The chevron is
// decorative only — sorting is not wired up.
function HeaderCell({ label, align = "left" }: { label: string; align?: "left" | "right" }) {
  return (
    <span
      className={`flex items-center gap-1.5 px-5 py-3.5 ${align === "right" ? "justify-end" : ""}`}
    >
      {label}
      {align === "right" ? null : <ChevronsUpDown size={13} className="text-[#c2ccd6]" />}
    </span>
  );
}

export default function Parties() {
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
  const [permitNumber, setPermitNumber] = useState("");
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
  const [editPermitNumber, setEditPermitNumber] = useState("");
  const [submittingEditClient, setSubmittingEditClient] = useState(false);

  // Disposal places — mirrors the client section above.
  const [disposalPlaces, setDisposalPlaces] = useState<DisposalPlaceRow[]>([]);
  const [loadingDisposal, setLoadingDisposal] = useState(false);
  const [disposalError, setDisposalError] = useState("");
  const [disposalSuccess, setDisposalSuccess] = useState("");
  const [isDisposalDialogOpen, setIsDisposalDialogOpen] = useState(false);
  const [disposalForm, setDisposalForm] = useState(EMPTY_DISPOSAL_FORM);
  const [submittingDisposal, setSubmittingDisposal] = useState(false);
  const [activeMenuDisposalId, setActiveMenuDisposalId] = useState<string | null>(null);
  const [deletingDisposalId, setDeletingDisposalId] = useState<string | null>(null);
  const [isDisposalEditOpen, setIsDisposalEditOpen] = useState(false);
  const [editingDisposalId, setEditingDisposalId] = useState<string | null>(null);
  const [disposalEditForm, setDisposalEditForm] = useState(EMPTY_DISPOSAL_FORM);
  const [submittingDisposalEdit, setSubmittingDisposalEdit] = useState(false);

  // Contacts — mirrors the disposal-places section above.
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [loadingContacts, setLoadingContacts] = useState(false);
  const [contactError, setContactError] = useState("");
  const [contactSuccess, setContactSuccess] = useState("");
  const [isContactDialogOpen, setIsContactDialogOpen] = useState(false);
  const [contactForm, setContactForm] = useState(EMPTY_CONTACT_FORM);
  const [submittingContact, setSubmittingContact] = useState(false);
  const [activeMenuContactId, setActiveMenuContactId] = useState<string | null>(null);
  const [deletingContactId, setDeletingContactId] = useState<string | null>(null);
  const [isContactEditOpen, setIsContactEditOpen] = useState(false);
  const [editingContactId, setEditingContactId] = useState<string | null>(null);
  const [contactEditForm, setContactEditForm] = useState(EMPTY_CONTACT_FORM);
  const [submittingContactEdit, setSubmittingContactEdit] = useState(false);

  // firm_id → firm name, so a contact card can show which firm it belongs to without
  // an extra fetch. `clients` holds the firms (this page predates the client→firm rename).
  const firmNameById = useMemo(
    () => new Map(clients.map((firm) => [firm.id, firm.name])),
    [clients]
  );

  // Directory toggle — the URL ?tab= param is the source of truth so the
  // selection survives reloads, deep links, and the back button.
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = parsePartiesTab(searchParams.get("tab"));

  const selectTab = (tab: PartiesTab) => {
    // Switching directories closes any open row menu so it doesn't linger.
    setActiveMenuClientId(null);
    setActiveMenuDisposalId(null);
    setActiveMenuContactId(null);
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (tab === DEFAULT_PARTIES_TAB) {
          next.delete("tab");
        } else {
          next.set("tab", tab);
        }
        return next;
      },
      { replace: true }
    );
  };

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

      const inClientMenu =
        target.closest("[data-client-menu]") || target.closest("[data-client-menu-trigger]");
      const inDisposalMenu =
        target.closest("[data-disposal-menu]") || target.closest("[data-disposal-menu-trigger]");
      const inContactMenu =
        target.closest("[data-contact-menu]") || target.closest("[data-contact-menu-trigger]");

      // Close every menu except the one whose own trigger/menu was clicked.
      if (!inClientMenu) setActiveMenuClientId(null);
      if (!inDisposalMenu) setActiveMenuDisposalId(null);
      if (!inContactMenu) setActiveMenuContactId(null);
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
      setClientError("A firm with the same name already exists for this tenant.");
      return;
    }

    setSubmittingClient(true);
    try {
      const created = await createFirmProfile({
        name,
        email,
        city: city.trim() ? city.trim() : null,
        tax_number: taxNumber.trim() ? taxNumber.trim() : null,
        phone: phone.trim() ? phone : null,
        address: address.trim() ? address : null,
        notes: notes.trim() ? notes : null,
        permit_number: permitNumber.trim() ? permitNumber.trim() : null,
      });

      const data = await getFirmsByTenant();
      setClients(data);
      setClientSuccess(`Firm ${created.name} created successfully.`);
      setName("");
      setEmail("");
      setCity("");
      setTaxNumber("");
      setPhone("");
      setAddress("");
      setNotes("");
      setPermitNumber("");
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
        const data = await getFirmsByTenant();
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

  useEffect(() => {
    if (!tenantIdentifier) {
      setDisposalPlaces([]);
      return;
    }

    let isMounted = true;

    const loadDisposalPlaces = async () => {
      setLoadingDisposal(true);
      try {
        const data = await getDisposalPlacesByTenant();
        if (isMounted) {
          setDisposalPlaces(data);
        }
      } catch (fetchError) {
        if (isMounted) {
          setDisposalError((fetchError as Error).message);
          setDisposalPlaces([]);
        }
      } finally {
        if (isMounted) {
          setLoadingDisposal(false);
        }
      }
    };

    void loadDisposalPlaces();

    return () => {
      isMounted = false;
    };
  }, [tenantIdentifier]);

  const handleCreateDisposalPlace = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setDisposalError("");
    setDisposalSuccess("");

    if (!tenantIdentifier) {
      setDisposalError("Tenant ID is still loading. Try again in a moment.");
      return;
    }

    setSubmittingDisposal(true);
    try {
      const created = await createDisposalPlace({
        name: disposalForm.name.trim(),
        address: disposalForm.address.trim(),
        place: disposalForm.place.trim(),
        email: disposalForm.email.trim(),
        phone_number: disposalForm.phone_number.trim(),
      });

      const data = await getDisposalPlacesByTenant();
      setDisposalPlaces(data);
      setDisposalSuccess(`Disposal place ${created.name} created successfully.`);
      setDisposalForm(EMPTY_DISPOSAL_FORM);
      setIsDisposalDialogOpen(false);
    } catch (createError) {
      setDisposalError((createError as Error).message);
    } finally {
      setSubmittingDisposal(false);
    }
  };

  const handleDeleteDisposalPlace = async (place: DisposalPlaceRow) => {
    if (!tenantIdentifier || deletingDisposalId) {
      return;
    }

    const confirmed = window.confirm(`Delete disposal place \"${place.name}\"? This action cannot be undone.`);
    if (!confirmed) {
      return;
    }

    setDisposalError("");
    setDisposalSuccess("");
    setDeletingDisposalId(place.id);

    try {
      await deleteDisposalPlaceById(place.id);
      setDisposalPlaces((current) => current.filter((item) => item.id !== place.id));
      setDisposalSuccess(`Disposal place ${place.name} deleted.`);
      setActiveMenuDisposalId(null);
    } catch (deleteError) {
      setDisposalError((deleteError as Error).message);
    } finally {
      setDeletingDisposalId(null);
    }
  };

  const openDisposalEditDialog = (place: DisposalPlaceRow) => {
    setDisposalError("");
    setDisposalSuccess("");
    setActiveMenuDisposalId(null);
    setEditingDisposalId(place.id);
    setDisposalEditForm({
      name: place.name,
      address: place.address,
      place: place.place,
      email: place.email,
      phone_number: place.phone_number,
    });
    setIsDisposalEditOpen(true);
  };

  const closeDisposalEditDialog = () => {
    if (submittingDisposalEdit) {
      return;
    }
    setIsDisposalEditOpen(false);
    setEditingDisposalId(null);
  };

  const handleEditDisposalPlace = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!tenantIdentifier || !editingDisposalId) {
      setDisposalError("Unable to update disposal place right now. Try again.");
      return;
    }

    setDisposalError("");
    setDisposalSuccess("");
    setSubmittingDisposalEdit(true);

    try {
      const updated = await updateDisposalPlaceById(editingDisposalId, {
        name: disposalEditForm.name.trim(),
        address: disposalEditForm.address.trim(),
        place: disposalEditForm.place.trim(),
        email: disposalEditForm.email.trim(),
        phone_number: disposalEditForm.phone_number.trim(),
      });

      setDisposalPlaces((current) =>
        current.map((place) => (place.id === updated.id ? updated : place))
      );
      setDisposalSuccess(`Disposal place ${updated.name} updated successfully.`);
      setIsDisposalEditOpen(false);
      setEditingDisposalId(null);
    } catch (updateError) {
      setDisposalError((updateError as Error).message);
    } finally {
      setSubmittingDisposalEdit(false);
    }
  };

  useEffect(() => {
    if (!tenantIdentifier) {
      setContacts([]);
      return;
    }

    let isMounted = true;

    const loadContacts = async () => {
      setLoadingContacts(true);
      try {
        const data = await getContactsByTenant();
        if (isMounted) {
          setContacts(data);
        }
      } catch (fetchError) {
        if (isMounted) {
          setContactError((fetchError as Error).message);
          setContacts([]);
        }
      } finally {
        if (isMounted) {
          setLoadingContacts(false);
        }
      }
    };

    void loadContacts();

    return () => {
      isMounted = false;
    };
  }, [tenantIdentifier]);

  const handleCreateContact = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setContactError("");
    setContactSuccess("");

    if (!tenantIdentifier) {
      setContactError("Tenant ID is still loading. Try again in a moment.");
      return;
    }

    if (!contactForm.firm_id) {
      setContactError("Select the firm this contact belongs to.");
      return;
    }

    setSubmittingContact(true);
    try {
      const created = await createContact({
        firm_id: contactForm.firm_id,
        name: contactForm.name.trim(),
        email: contactForm.email.trim(),
        phone_number: contactForm.phone_number.trim(),
        address: contactForm.address.trim(),
      });

      const data = await getContactsByTenant();
      setContacts(data);
      setContactSuccess(`Contact ${created.name} created successfully.`);
      setContactForm(EMPTY_CONTACT_FORM);
      setIsContactDialogOpen(false);
    } catch (createError) {
      setContactError((createError as Error).message);
    } finally {
      setSubmittingContact(false);
    }
  };

  const handleDeleteContact = async (contact: ContactRow) => {
    if (!tenantIdentifier || deletingContactId) {
      return;
    }

    const confirmed = window.confirm(`Delete contact \"${contact.name}\"? This action cannot be undone.`);
    if (!confirmed) {
      return;
    }

    setContactError("");
    setContactSuccess("");
    setDeletingContactId(contact.id);

    try {
      await deleteContactById(contact.id);
      setContacts((current) => current.filter((item) => item.id !== contact.id));
      setContactSuccess(`Contact ${contact.name} deleted.`);
      setActiveMenuContactId(null);
    } catch (deleteError) {
      setContactError((deleteError as Error).message);
    } finally {
      setDeletingContactId(null);
    }
  };

  const openContactEditDialog = (contact: ContactRow) => {
    setContactError("");
    setContactSuccess("");
    setActiveMenuContactId(null);
    setEditingContactId(contact.id);
    setContactEditForm({
      firm_id: contact.firm_id,
      name: contact.name,
      email: contact.email,
      phone_number: contact.phone_number,
      address: contact.address,
    });
    setIsContactEditOpen(true);
  };

  const closeContactEditDialog = () => {
    if (submittingContactEdit) {
      return;
    }
    setIsContactEditOpen(false);
    setEditingContactId(null);
  };

  const handleEditContact = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!tenantIdentifier || !editingContactId) {
      setContactError("Unable to update contact right now. Try again.");
      return;
    }

    if (!contactEditForm.firm_id) {
      setContactError("Select the firm this contact belongs to.");
      return;
    }

    setContactError("");
    setContactSuccess("");
    setSubmittingContactEdit(true);

    try {
      const updated = await updateContactById(editingContactId, {
        firm_id: contactEditForm.firm_id,
        name: contactEditForm.name.trim(),
        email: contactEditForm.email.trim(),
        phone_number: contactEditForm.phone_number.trim(),
        address: contactEditForm.address.trim(),
      });

      setContacts((current) =>
        current.map((contact) => (contact.id === updated.id ? updated : contact))
      );
      setContactSuccess(`Contact ${updated.name} updated successfully.`);
      setIsContactEditOpen(false);
      setEditingContactId(null);
    } catch (updateError) {
      setContactError((updateError as Error).message);
    } finally {
      setSubmittingContactEdit(false);
    }
  };

  const handleDeleteClient = async (client: ClientRow) => {
    if (!tenantIdentifier || deletingClientId) {
      return;
    }

    const confirmed = window.confirm(`Delete firm \"${client.name}\"? This action cannot be undone.`);
    if (!confirmed) {
      return;
    }

    setClientError("");
    setClientSuccess("");
    setDeletingClientId(client.id);

    try {
      await deleteFirmById(client.id);
      setClients((current) => current.filter((item) => item.id !== client.id));
      setClientSuccess(`Firm ${client.name} deleted.`);
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
    setEditPermitNumber(client.permit_number ?? "");
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
      setClientError("Unable to update firm right now. Try again.");
      return;
    }

    setClientError("");
    setClientSuccess("");
    setSubmittingEditClient(true);

    try {
      const updated = await updateFirmById(editingClientId, {
        name: editName,
        email: editEmail,
        city: editCity.trim() ? editCity.trim() : null,
        tax_number: editTaxNumber.trim() ? editTaxNumber.trim() : null,
        phone: editPhone.trim() ? editPhone : null,
        address: editAddress.trim() ? editAddress : null,
        notes: editNotes.trim() ? editNotes : null,
        permit_number: editPermitNumber.trim() ? editPermitNumber.trim() : null,
      });

      setClients((current) =>
        current.map((client) => (client.id === updated.id ? ({ ...client, ...updated } as ClientRow) : client))
      );
      setClientSuccess(`Firm ${updated.name} updated successfully.`);
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
        <h1 className="text-xl font-medium tracking-[-0.01em] text-[var(--brand-ink)]">Parties</h1>
        <p className="mt-1 text-sm text-[var(--brand-text-muted)]">Firms, disposal places, and contacts under your tenant.</p>

        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={() => {
              setContactError("");
              setContactSuccess("");
              setContactForm(EMPTY_CONTACT_FORM);
              setIsContactDialogOpen(true);
            }}
            disabled={!tenantIdentifier}
            className="inline-flex h-10 items-center justify-center rounded-full border border-[var(--brand-teal)] px-4 text-sm font-medium text-[var(--brand-teal)] transition hover:bg-[var(--brand-teal-soft)] disabled:cursor-not-allowed disabled:opacity-70"
          >
            Quick Add Contact
          </button>
          <button
            type="button"
            onClick={() => {
              setDisposalError("");
              setDisposalSuccess("");
              setDisposalForm(EMPTY_DISPOSAL_FORM);
              setIsDisposalDialogOpen(true);
            }}
            disabled={!tenantIdentifier}
            className="inline-flex h-10 items-center justify-center rounded-full border border-[var(--brand-teal)] px-4 text-sm font-medium text-[var(--brand-teal)] transition hover:bg-[var(--brand-teal-soft)] disabled:cursor-not-allowed disabled:opacity-70"
          >
            Quick Add Disposal Place
          </button>
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
            Quick Add Firm
          </button>
        </div>

        {/* Directory toggle — renders only the selected table below. */}
        <nav
          aria-label="Party directories"
          className="mt-5 flex items-center gap-6 border-b border-[var(--brand-border)]"
        >
          {PARTIES_TABS.map((tab) => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                aria-current={isActive ? "page" : undefined}
                onClick={() => selectTab(tab.id)}
                className={`-mb-px border-b-2 px-1 pb-3 text-sm transition ${
                  isActive
                    ? "border-[var(--brand-ink)] font-semibold text-[var(--brand-ink)]"
                    : "border-transparent font-medium text-[var(--brand-text-muted)] hover:text-[var(--brand-ink)]"
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </nav>
      </header>

      {isDialogOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(15,25,35,0.45)] p-4">
          <div className="w-full max-w-2xl rounded-xl border border-[var(--brand-border)] bg-[var(--brand-card)] p-4 shadow-xl shadow-slate-900/20">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-medium text-[var(--brand-ink)]">Quick Add Firm</h2>
                <p className="mt-1 text-[13px] text-[var(--brand-text-muted)]">
                  Create a firm without leaving this page.
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
                    placeholder="Firm name"
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

                <label className="block space-y-2">
                  <span className="text-sm font-medium text-[var(--brand-ink)]">Permit number optional</span>
                  <input
                    type="text"
                    value={permitNumber}
                    onChange={(event) => setPermitNumber(event.target.value)}
                    maxLength={60}
                    placeholder="e.g. 00123 or MK-2024/551"
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
                  placeholder="Any context for this firm"
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
                  A firm with this name already exists for this tenant.
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
                  {submittingClient ? "Creating firm..." : "Create firm"}
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
                <h2 className="text-lg font-medium text-[var(--brand-ink)]">Edit Firm</h2>
                <p className="mt-1 text-[13px] text-[var(--brand-text-muted)]">
                  Update firm details without leaving this page.
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
                    placeholder="Firm name"
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

                <label className="block space-y-2">
                  <span className="text-sm font-medium text-[var(--brand-ink)]">Permit number optional</span>
                  <input
                    type="text"
                    value={editPermitNumber}
                    onChange={(event) => setEditPermitNumber(event.target.value)}
                    maxLength={60}
                    placeholder="e.g. 00123 or MK-2024/551"
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
                  placeholder="Any context for this firm"
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

      {isDisposalDialogOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(15,25,35,0.45)] p-4">
          <div className="w-full max-w-2xl rounded-xl border border-[var(--brand-border)] bg-[var(--brand-card)] p-4 shadow-xl shadow-slate-900/20">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-medium text-[var(--brand-ink)]">Quick Add Disposal Place</h2>
                <p className="mt-1 text-[13px] text-[var(--brand-text-muted)]">
                  Create a disposal place without leaving this page.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsDisposalDialogOpen(false)}
                className="h-9 rounded-md border border-[var(--brand-border)] px-3 text-sm text-[var(--brand-text-muted)] transition hover:border-[var(--brand-teal)] hover:text-[var(--brand-teal)]"
              >
                Close
              </button>
            </div>

            <p className="mb-4 text-[11px] text-[var(--brand-text-muted)]">{userEmail ?? "Unknown"} · {tenantIdentifier ?? "Loading..."}</p>

            <form onSubmit={handleCreateDisposalPlace} className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <label className="block space-y-2">
                  <span className="text-sm font-medium text-[var(--brand-ink)]">Name</span>
                  <input
                    type="text"
                    value={disposalForm.name}
                    onChange={(event) => setDisposalForm((f) => ({ ...f, name: event.target.value }))}
                    minLength={1}
                    maxLength={120}
                    placeholder="Disposal place name"
                    className="h-11 w-full rounded-lg border border-[var(--brand-border)] bg-[var(--brand-surface)] px-4 text-sm outline-none transition focus:border-[var(--brand-teal)] focus:bg-white"
                    required
                  />
                </label>

                <label className="block space-y-2">
                  <span className="text-sm font-medium text-[var(--brand-ink)]">Email</span>
                  <input
                    type="email"
                    value={disposalForm.email}
                    onChange={(event) => setDisposalForm((f) => ({ ...f, email: event.target.value }))}
                    minLength={3}
                    maxLength={254}
                    placeholder="site@example.com"
                    className="h-11 w-full rounded-lg border border-[var(--brand-border)] bg-[var(--brand-surface)] px-4 text-sm outline-none transition focus:border-[var(--brand-teal)] focus:bg-white"
                    required
                  />
                </label>

                <label className="block space-y-2">
                  <span className="text-sm font-medium text-[var(--brand-ink)]">Place</span>
                  <input
                    type="text"
                    value={disposalForm.place}
                    onChange={(event) => setDisposalForm((f) => ({ ...f, place: event.target.value }))}
                    minLength={1}
                    maxLength={120}
                    placeholder="Skopje"
                    className="h-11 w-full rounded-lg border border-[var(--brand-border)] bg-[var(--brand-surface)] px-4 text-sm outline-none transition focus:border-[var(--brand-teal)] focus:bg-white"
                    required
                  />
                </label>

                <label className="block space-y-2">
                  <span className="text-sm font-medium text-[var(--brand-ink)]">Phone number</span>
                  <input
                    type="tel"
                    value={disposalForm.phone_number}
                    onChange={(event) => setDisposalForm((f) => ({ ...f, phone_number: event.target.value }))}
                    minLength={1}
                    maxLength={30}
                    placeholder="+389 2 123 456"
                    className="h-11 w-full rounded-lg border border-[var(--brand-border)] bg-[var(--brand-surface)] px-4 text-sm outline-none transition focus:border-[var(--brand-teal)] focus:bg-white"
                    required
                  />
                </label>
              </div>

              <label className="block space-y-2">
                <span className="text-sm font-medium text-[var(--brand-ink)]">Address</span>
                <input
                  type="text"
                  value={disposalForm.address}
                  onChange={(event) => setDisposalForm((f) => ({ ...f, address: event.target.value }))}
                  minLength={1}
                  maxLength={255}
                  placeholder="Street, number"
                  className="h-11 w-full rounded-lg border border-[var(--brand-border)] bg-[var(--brand-surface)] px-4 text-sm outline-none transition focus:border-[var(--brand-teal)] focus:bg-white"
                  required
                />
              </label>

              {disposalError ? (
                <div className="rounded-lg border border-[#f7cccc] bg-[var(--brand-danger-bg)] px-4 py-3 text-sm text-[var(--brand-danger-text)]">
                  {disposalError}
                </div>
              ) : null}

              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setIsDisposalDialogOpen(false)}
                  className="inline-flex h-11 items-center justify-center rounded-lg border border-[var(--brand-border)] px-5 text-sm font-medium text-[var(--brand-text-muted)] transition hover:border-[var(--brand-teal)] hover:text-[var(--brand-teal)]"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submittingDisposal || !tenantIdentifier}
                  className="inline-flex h-11 items-center justify-center rounded-lg bg-[var(--brand-teal)] px-5 text-sm font-medium text-white transition hover:bg-[#2f8575] disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {submittingDisposal ? "Creating..." : "Create disposal place"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {isDisposalEditOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(15,25,35,0.45)] p-4">
          <div className="w-full max-w-2xl rounded-xl border border-[var(--brand-border)] bg-[var(--brand-card)] p-4 shadow-xl shadow-slate-900/20">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-medium text-[var(--brand-ink)]">Edit Disposal Place</h2>
                <p className="mt-1 text-[13px] text-[var(--brand-text-muted)]">
                  Update disposal place details without leaving this page.
                </p>
              </div>
              <button
                type="button"
                onClick={closeDisposalEditDialog}
                className="h-9 rounded-md border border-[var(--brand-border)] px-3 text-sm text-[var(--brand-text-muted)] transition hover:border-[var(--brand-teal)] hover:text-[var(--brand-teal)]"
              >
                Close
              </button>
            </div>

            <p className="mb-4 text-[11px] text-[var(--brand-text-muted)]">{userEmail ?? "Unknown"} · {tenantIdentifier ?? "Loading..."}</p>

            <form onSubmit={handleEditDisposalPlace} className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <label className="block space-y-2">
                  <span className="text-sm font-medium text-[var(--brand-ink)]">Name</span>
                  <input
                    type="text"
                    value={disposalEditForm.name}
                    onChange={(event) => setDisposalEditForm((f) => ({ ...f, name: event.target.value }))}
                    minLength={1}
                    maxLength={120}
                    placeholder="Disposal place name"
                    className="h-11 w-full rounded-lg border border-[var(--brand-border)] bg-[var(--brand-surface)] px-4 text-sm outline-none transition focus:border-[var(--brand-teal)] focus:bg-white"
                    required
                  />
                </label>

                <label className="block space-y-2">
                  <span className="text-sm font-medium text-[var(--brand-ink)]">Email</span>
                  <input
                    type="email"
                    value={disposalEditForm.email}
                    onChange={(event) => setDisposalEditForm((f) => ({ ...f, email: event.target.value }))}
                    minLength={3}
                    maxLength={254}
                    placeholder="site@example.com"
                    className="h-11 w-full rounded-lg border border-[var(--brand-border)] bg-[var(--brand-surface)] px-4 text-sm outline-none transition focus:border-[var(--brand-teal)] focus:bg-white"
                    required
                  />
                </label>

                <label className="block space-y-2">
                  <span className="text-sm font-medium text-[var(--brand-ink)]">Place</span>
                  <input
                    type="text"
                    value={disposalEditForm.place}
                    onChange={(event) => setDisposalEditForm((f) => ({ ...f, place: event.target.value }))}
                    minLength={1}
                    maxLength={120}
                    placeholder="Skopje"
                    className="h-11 w-full rounded-lg border border-[var(--brand-border)] bg-[var(--brand-surface)] px-4 text-sm outline-none transition focus:border-[var(--brand-teal)] focus:bg-white"
                    required
                  />
                </label>

                <label className="block space-y-2">
                  <span className="text-sm font-medium text-[var(--brand-ink)]">Phone number</span>
                  <input
                    type="tel"
                    value={disposalEditForm.phone_number}
                    onChange={(event) => setDisposalEditForm((f) => ({ ...f, phone_number: event.target.value }))}
                    minLength={1}
                    maxLength={30}
                    placeholder="+389 2 123 456"
                    className="h-11 w-full rounded-lg border border-[var(--brand-border)] bg-[var(--brand-surface)] px-4 text-sm outline-none transition focus:border-[var(--brand-teal)] focus:bg-white"
                    required
                  />
                </label>
              </div>

              <label className="block space-y-2">
                <span className="text-sm font-medium text-[var(--brand-ink)]">Address</span>
                <input
                  type="text"
                  value={disposalEditForm.address}
                  onChange={(event) => setDisposalEditForm((f) => ({ ...f, address: event.target.value }))}
                  minLength={1}
                  maxLength={255}
                  placeholder="Street, number"
                  className="h-11 w-full rounded-lg border border-[var(--brand-border)] bg-[var(--brand-surface)] px-4 text-sm outline-none transition focus:border-[var(--brand-teal)] focus:bg-white"
                  required
                />
              </label>

              {disposalError ? (
                <div className="rounded-lg border border-[#f7cccc] bg-[var(--brand-danger-bg)] px-4 py-3 text-sm text-[var(--brand-danger-text)]">
                  {disposalError}
                </div>
              ) : null}

              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={closeDisposalEditDialog}
                  className="inline-flex h-11 items-center justify-center rounded-lg border border-[var(--brand-border)] px-5 text-sm font-medium text-[var(--brand-text-muted)] transition hover:border-[var(--brand-teal)] hover:text-[var(--brand-teal)]"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submittingDisposalEdit || !tenantIdentifier || !editingDisposalId}
                  className="inline-flex h-11 items-center justify-center rounded-lg bg-[var(--brand-teal)] px-5 text-sm font-medium text-white transition hover:bg-[#2f8575] disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {submittingDisposalEdit ? "Saving..." : "Save changes"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {isContactDialogOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(15,25,35,0.45)] p-4">
          <div className="w-full max-w-2xl rounded-xl border border-[var(--brand-border)] bg-[var(--brand-card)] p-4 shadow-xl shadow-slate-900/20">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-medium text-[var(--brand-ink)]">Quick Add Contact</h2>
                <p className="mt-1 text-[13px] text-[var(--brand-text-muted)]">
                  Create a contact without leaving this page.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsContactDialogOpen(false)}
                className="h-9 rounded-md border border-[var(--brand-border)] px-3 text-sm text-[var(--brand-text-muted)] transition hover:border-[var(--brand-teal)] hover:text-[var(--brand-teal)]"
              >
                Close
              </button>
            </div>

            <p className="mb-4 text-[11px] text-[var(--brand-text-muted)]">{userEmail ?? "Unknown"} · {tenantIdentifier ?? "Loading..."}</p>

            <form onSubmit={handleCreateContact} className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <label className="block space-y-2 md:col-span-2">
                  <span className="text-sm font-medium text-[var(--brand-ink)]">Firm</span>
                  <select
                    value={contactForm.firm_id}
                    onChange={(event) => setContactForm((f) => ({ ...f, firm_id: event.target.value }))}
                    className="h-11 w-full rounded-lg border border-[var(--brand-border)] bg-[var(--brand-surface)] px-4 text-sm outline-none transition focus:border-[var(--brand-teal)] focus:bg-white"
                    required
                  >
                    <option value="" disabled>
                      Select a firm…
                    </option>
                    {clients.map((firm) => (
                      <option key={firm.id} value={firm.id}>
                        {firm.name}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="block space-y-2">
                  <span className="text-sm font-medium text-[var(--brand-ink)]">Name</span>
                  <input
                    type="text"
                    value={contactForm.name}
                    onChange={(event) => setContactForm((f) => ({ ...f, name: event.target.value }))}
                    minLength={1}
                    maxLength={120}
                    placeholder="Contact name"
                    className="h-11 w-full rounded-lg border border-[var(--brand-border)] bg-[var(--brand-surface)] px-4 text-sm outline-none transition focus:border-[var(--brand-teal)] focus:bg-white"
                    required
                  />
                </label>

                <label className="block space-y-2">
                  <span className="text-sm font-medium text-[var(--brand-ink)]">Email</span>
                  <input
                    type="email"
                    value={contactForm.email}
                    onChange={(event) => setContactForm((f) => ({ ...f, email: event.target.value }))}
                    minLength={3}
                    maxLength={254}
                    placeholder="person@example.com"
                    className="h-11 w-full rounded-lg border border-[var(--brand-border)] bg-[var(--brand-surface)] px-4 text-sm outline-none transition focus:border-[var(--brand-teal)] focus:bg-white"
                    required
                  />
                </label>

                <label className="block space-y-2">
                  <span className="text-sm font-medium text-[var(--brand-ink)]">Phone number</span>
                  <input
                    type="tel"
                    value={contactForm.phone_number}
                    onChange={(event) => setContactForm((f) => ({ ...f, phone_number: event.target.value }))}
                    minLength={1}
                    maxLength={30}
                    placeholder="+389 70 123 456"
                    className="h-11 w-full rounded-lg border border-[var(--brand-border)] bg-[var(--brand-surface)] px-4 text-sm outline-none transition focus:border-[var(--brand-teal)] focus:bg-white"
                    required
                  />
                </label>

                <label className="block space-y-2">
                  <span className="text-sm font-medium text-[var(--brand-ink)]">Address</span>
                  <input
                    type="text"
                    value={contactForm.address}
                    onChange={(event) => setContactForm((f) => ({ ...f, address: event.target.value }))}
                    minLength={1}
                    maxLength={255}
                    placeholder="Street, number"
                    className="h-11 w-full rounded-lg border border-[var(--brand-border)] bg-[var(--brand-surface)] px-4 text-sm outline-none transition focus:border-[var(--brand-teal)] focus:bg-white"
                    required
                  />
                </label>
              </div>

              {contactError ? (
                <div className="rounded-lg border border-[#f7cccc] bg-[var(--brand-danger-bg)] px-4 py-3 text-sm text-[var(--brand-danger-text)]">
                  {contactError}
                </div>
              ) : null}

              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setIsContactDialogOpen(false)}
                  className="inline-flex h-11 items-center justify-center rounded-lg border border-[var(--brand-border)] px-5 text-sm font-medium text-[var(--brand-text-muted)] transition hover:border-[var(--brand-teal)] hover:text-[var(--brand-teal)]"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submittingContact || !tenantIdentifier}
                  className="inline-flex h-11 items-center justify-center rounded-lg bg-[var(--brand-teal)] px-5 text-sm font-medium text-white transition hover:bg-[#2f8575] disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {submittingContact ? "Creating..." : "Create contact"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {isContactEditOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(15,25,35,0.45)] p-4">
          <div className="w-full max-w-2xl rounded-xl border border-[var(--brand-border)] bg-[var(--brand-card)] p-4 shadow-xl shadow-slate-900/20">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-medium text-[var(--brand-ink)]">Edit Contact</h2>
                <p className="mt-1 text-[13px] text-[var(--brand-text-muted)]">
                  Update contact details without leaving this page.
                </p>
              </div>
              <button
                type="button"
                onClick={closeContactEditDialog}
                className="h-9 rounded-md border border-[var(--brand-border)] px-3 text-sm text-[var(--brand-text-muted)] transition hover:border-[var(--brand-teal)] hover:text-[var(--brand-teal)]"
              >
                Close
              </button>
            </div>

            <p className="mb-4 text-[11px] text-[var(--brand-text-muted)]">{userEmail ?? "Unknown"} · {tenantIdentifier ?? "Loading..."}</p>

            <form onSubmit={handleEditContact} className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <label className="block space-y-2 md:col-span-2">
                  <span className="text-sm font-medium text-[var(--brand-ink)]">Firm</span>
                  <select
                    value={contactEditForm.firm_id}
                    onChange={(event) => setContactEditForm((f) => ({ ...f, firm_id: event.target.value }))}
                    className="h-11 w-full rounded-lg border border-[var(--brand-border)] bg-[var(--brand-surface)] px-4 text-sm outline-none transition focus:border-[var(--brand-teal)] focus:bg-white"
                    required
                  >
                    <option value="" disabled>
                      Select a firm…
                    </option>
                    {clients.map((firm) => (
                      <option key={firm.id} value={firm.id}>
                        {firm.name}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="block space-y-2">
                  <span className="text-sm font-medium text-[var(--brand-ink)]">Name</span>
                  <input
                    type="text"
                    value={contactEditForm.name}
                    onChange={(event) => setContactEditForm((f) => ({ ...f, name: event.target.value }))}
                    minLength={1}
                    maxLength={120}
                    placeholder="Contact name"
                    className="h-11 w-full rounded-lg border border-[var(--brand-border)] bg-[var(--brand-surface)] px-4 text-sm outline-none transition focus:border-[var(--brand-teal)] focus:bg-white"
                    required
                  />
                </label>

                <label className="block space-y-2">
                  <span className="text-sm font-medium text-[var(--brand-ink)]">Email</span>
                  <input
                    type="email"
                    value={contactEditForm.email}
                    onChange={(event) => setContactEditForm((f) => ({ ...f, email: event.target.value }))}
                    minLength={3}
                    maxLength={254}
                    placeholder="person@example.com"
                    className="h-11 w-full rounded-lg border border-[var(--brand-border)] bg-[var(--brand-surface)] px-4 text-sm outline-none transition focus:border-[var(--brand-teal)] focus:bg-white"
                    required
                  />
                </label>

                <label className="block space-y-2">
                  <span className="text-sm font-medium text-[var(--brand-ink)]">Phone number</span>
                  <input
                    type="tel"
                    value={contactEditForm.phone_number}
                    onChange={(event) => setContactEditForm((f) => ({ ...f, phone_number: event.target.value }))}
                    minLength={1}
                    maxLength={30}
                    placeholder="+389 70 123 456"
                    className="h-11 w-full rounded-lg border border-[var(--brand-border)] bg-[var(--brand-surface)] px-4 text-sm outline-none transition focus:border-[var(--brand-teal)] focus:bg-white"
                    required
                  />
                </label>

                <label className="block space-y-2">
                  <span className="text-sm font-medium text-[var(--brand-ink)]">Address</span>
                  <input
                    type="text"
                    value={contactEditForm.address}
                    onChange={(event) => setContactEditForm((f) => ({ ...f, address: event.target.value }))}
                    minLength={1}
                    maxLength={255}
                    placeholder="Street, number"
                    className="h-11 w-full rounded-lg border border-[var(--brand-border)] bg-[var(--brand-surface)] px-4 text-sm outline-none transition focus:border-[var(--brand-teal)] focus:bg-white"
                    required
                  />
                </label>
              </div>

              {contactError ? (
                <div className="rounded-lg border border-[#f7cccc] bg-[var(--brand-danger-bg)] px-4 py-3 text-sm text-[var(--brand-danger-text)]">
                  {contactError}
                </div>
              ) : null}

              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={closeContactEditDialog}
                  className="inline-flex h-11 items-center justify-center rounded-lg border border-[var(--brand-border)] px-5 text-sm font-medium text-[var(--brand-text-muted)] transition hover:border-[var(--brand-teal)] hover:text-[var(--brand-teal)]"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submittingContactEdit || !tenantIdentifier || !editingContactId}
                  className="inline-flex h-11 items-center justify-center rounded-lg bg-[var(--brand-teal)] px-5 text-sm font-medium text-white transition hover:bg-[#2f8575] disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {submittingContactEdit ? "Saving..." : "Save changes"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {activeTab === "firms" && (isResolvingTenant || loadingClients) ? (
        <div className="rounded-lg border border-[var(--brand-border)] bg-[var(--brand-card)] px-4 py-3 text-sm text-[var(--brand-text-muted)]">
          Loading firms...
        </div>
      ) : null}

      {!appLoading && !tenantIdentifier ? (
        <div className="rounded-lg border border-[#f7e0b6] bg-[var(--brand-warning-bg)] px-4 py-3 text-sm text-[var(--brand-warning-text)]">
          No business profile was found for this account yet.
        </div>
      ) : null}

      {activeTab === "firms" && error ? (
        <div className="rounded-lg border border-[#f7cccc] bg-[var(--brand-danger-bg)] px-4 py-3 text-sm text-[var(--brand-danger-text)]">{error}</div>
      ) : null}

      {activeTab === "firms" && !loadingClients && !error && tenantIdentifier ? (
        <div className="overflow-hidden rounded-xl border border-[var(--brand-border)] bg-[var(--brand-card)] shadow-sm shadow-slate-200/50">
          <div className="flex items-center justify-between border-b border-[#eef2f4] px-5 py-4">
            <div>
              <h2 className="text-[15px] font-semibold text-[var(--brand-ink)]">Firm Directory</h2>
              <p className="mt-0.5 text-xs text-[var(--brand-text-muted)]">Manage contacts, details, and onboarding context.</p>
            </div>
            <div className="rounded-full border border-[var(--brand-border)] bg-[var(--brand-card)] px-3 py-1 text-xs font-medium text-[var(--brand-text-muted)]">
              {clients.length} {clients.length === 1 ? "firm" : "firms"}
            </div>
          </div>

          <div className="overflow-x-auto">
            <div className="min-w-[920px]">
              <div className="grid grid-cols-[34%_20%_16%_14%_16%] border-b border-[#eef2f4] text-left text-[13px] font-medium text-[var(--brand-text-muted)]">
                <HeaderCell label="Firm" />
                <HeaderCell label="City" />
                <HeaderCell label="Phone" />
                <HeaderCell label="Added" />
                <HeaderCell label="Actions" align="right" />
              </div>

              <div className="max-h-[20rem] overflow-y-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
                {clients.length === 0 ? (
                  <div className="px-5 py-10 text-center text-sm text-[var(--brand-text-muted)]">No firms found for this tenant.</div>
                ) : (
                  clients.map((client) => (
                    <div
                      key={client.id}
                      className="grid h-[68px] grid-cols-[34%_20%_16%_14%_16%] border-b border-[#f1f4f7] text-sm text-[var(--brand-ink)] transition hover:bg-[#fafcfd] last:border-b-0"
                    >
                      <div className="flex items-center px-5">
                        <div className="flex items-center gap-3">
                          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[#cdeade] bg-[var(--brand-teal-soft)] text-xs font-semibold uppercase text-[#1a6b5a]">
                            {client.name.slice(0, 2)}
                          </span>
                          <div className="min-w-0">
                            <p className="truncate font-semibold leading-tight text-[var(--brand-ink)]">{client.name}</p>
                            <p className="truncate text-[13px] leading-tight text-[var(--brand-text-muted)]">{client.email}</p>
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center px-5 text-[var(--brand-text-muted)]">
                        {client.city ?? "-"}
                      </div>

                      <div className="flex items-center px-5">
                        {client.phone ? (
                          <span className="inline-flex rounded-full border border-[var(--brand-border)] bg-[var(--brand-card)] px-2.5 py-1 text-xs font-medium text-[var(--brand-text-muted)]">
                            {client.phone}
                          </span>
                        ) : (
                          <span className="text-[#a3afbd]">-</span>
                        )}
                      </div>

                      <div className="flex items-center px-5 text-[var(--brand-text-muted)]">
                        {client.created_at ? new Date(client.created_at).toLocaleDateString() : "-"}
                      </div>

                      <div className="relative flex items-center justify-end px-5">
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

                        {activeMenuClientId === client.id ? (
                          <div data-client-menu className="absolute right-5 top-[52px] z-20 w-28 rounded-lg border border-[var(--brand-border)] bg-[var(--brand-card)] p-1.5 shadow-lg shadow-slate-200/60">
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

      {activeTab === "disposal" && disposalSuccess ? (
        <div className="rounded-lg border border-[#cdeade] bg-[var(--brand-teal-soft)] px-4 py-3 text-sm text-[#1a6b5a]">
          {disposalSuccess}
        </div>
      ) : null}

      {activeTab === "disposal" && disposalError && !isDisposalDialogOpen && !isDisposalEditOpen ? (
        <div className="rounded-lg border border-[#f7cccc] bg-[var(--brand-danger-bg)] px-4 py-3 text-sm text-[var(--brand-danger-text)]">
          {disposalError}
        </div>
      ) : null}

      {activeTab === "disposal" && !loadingDisposal && tenantIdentifier ? (
        <div className="overflow-hidden rounded-xl border border-[var(--brand-border)] bg-[var(--brand-card)] shadow-sm shadow-slate-200/50">
          <div className="flex items-center justify-between border-b border-[#eef2f4] px-5 py-4">
            <div>
              <h2 className="text-[15px] font-semibold text-[var(--brand-ink)]">Disposal Places</h2>
              <p className="mt-0.5 text-xs text-[var(--brand-text-muted)]">Waste disposal sites your business works with.</p>
            </div>
            <div className="rounded-full border border-[var(--brand-border)] bg-[var(--brand-card)] px-3 py-1 text-xs font-medium text-[var(--brand-text-muted)]">
              {disposalPlaces.length} {disposalPlaces.length === 1 ? "place" : "places"}
            </div>
          </div>

          <div className="overflow-x-auto">
            <div className="min-w-[920px]">
              <div className="grid grid-cols-[32%_18%_16%_20%_14%] border-b border-[#eef2f4] text-left text-[13px] font-medium text-[var(--brand-text-muted)]">
                <HeaderCell label="Name" />
                <HeaderCell label="Place" />
                <HeaderCell label="Phone" />
                <HeaderCell label="Address" />
                <HeaderCell label="Actions" align="right" />
              </div>

              <div className="max-h-[20rem] overflow-y-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
                {disposalPlaces.length === 0 ? (
                  <div className="px-5 py-10 text-center text-sm text-[var(--brand-text-muted)]">No disposal places found for this tenant.</div>
                ) : (
                  disposalPlaces.map((place) => (
                    <div
                      key={place.id}
                      className="grid h-[68px] grid-cols-[32%_18%_16%_20%_14%] border-b border-[#f1f4f7] text-sm text-[var(--brand-ink)] transition hover:bg-[#fafcfd] last:border-b-0"
                    >
                      <div className="flex items-center px-5">
                        <div className="flex items-center gap-3">
                          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[#cdeade] bg-[var(--brand-teal-soft)] text-xs font-semibold uppercase text-[#1a6b5a]">
                            {place.name.slice(0, 2)}
                          </span>
                          <div className="min-w-0">
                            <p className="truncate font-semibold leading-tight text-[var(--brand-ink)]">{place.name}</p>
                            <p className="truncate text-[13px] leading-tight text-[var(--brand-text-muted)]">{place.email}</p>
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center px-5 text-[var(--brand-text-muted)]">
                        {place.place}
                      </div>

                      <div className="flex items-center px-5">
                        <span className="inline-flex rounded-full border border-[var(--brand-border)] bg-[var(--brand-card)] px-2.5 py-1 text-xs font-medium text-[var(--brand-text-muted)]">
                          {place.phone_number}
                        </span>
                      </div>

                      <div className="flex items-center px-5 text-[var(--brand-text-muted)]">
                        <span className="block truncate">{place.address}</span>
                      </div>

                      <div className="relative flex items-center justify-end px-5">
                        <button
                          type="button"
                          data-disposal-menu-trigger
                          aria-haspopup="menu"
                          aria-expanded={activeMenuDisposalId === place.id}
                          onClick={() => {
                            setActiveMenuDisposalId((current) => (current === place.id ? null : place.id));
                          }}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-[var(--brand-border)] bg-[var(--brand-card)] text-[var(--brand-text-muted)] transition hover:border-[var(--brand-teal)] hover:text-[var(--brand-teal)]"
                        >
                          <MoreHorizontal size={15} />
                        </button>

                        {activeMenuDisposalId === place.id ? (
                          <div data-disposal-menu className="absolute right-5 top-[52px] z-20 w-28 rounded-lg border border-[var(--brand-border)] bg-[var(--brand-card)] p-1.5 shadow-lg shadow-slate-200/60">
                            <button
                              type="button"
                              onClick={() => openDisposalEditDialog(place)}
                              className="flex w-full items-center justify-start rounded-md px-2.5 py-2 text-xs font-medium text-[var(--brand-ink)] transition hover:bg-[var(--brand-surface)]"
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                void handleDeleteDisposalPlace(place);
                              }}
                              disabled={deletingDisposalId === place.id}
                              className="flex w-full items-center justify-start rounded-md px-2.5 py-2 text-xs font-medium text-[var(--brand-danger-text)] transition hover:bg-[var(--brand-danger-bg)]"
                            >
                              {deletingDisposalId === place.id ? "Deleting..." : "Delete"}
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

      {activeTab === "contacts" && contactSuccess ? (
        <div className="rounded-lg border border-[#cdeade] bg-[var(--brand-teal-soft)] px-4 py-3 text-sm text-[#1a6b5a]">
          {contactSuccess}
        </div>
      ) : null}

      {activeTab === "contacts" && contactError && !isContactDialogOpen && !isContactEditOpen ? (
        <div className="rounded-lg border border-[#f7cccc] bg-[var(--brand-danger-bg)] px-4 py-3 text-sm text-[var(--brand-danger-text)]">
          {contactError}
        </div>
      ) : null}

      {activeTab === "contacts" && !loadingContacts && tenantIdentifier ? (
        <div className="overflow-hidden rounded-xl border border-[var(--brand-border)] bg-[var(--brand-card)] shadow-sm shadow-slate-200/50">
          <div className="flex items-center justify-between border-b border-[#eef2f4] px-5 py-4">
            <div>
              <h2 className="text-[15px] font-semibold text-[var(--brand-ink)]">Contacts</h2>
              <p className="mt-0.5 text-xs text-[var(--brand-text-muted)]">Individual people you keep in touch with.</p>
            </div>
            <div className="rounded-full border border-[var(--brand-border)] bg-[var(--brand-card)] px-3 py-1 text-xs font-medium text-[var(--brand-text-muted)]">
              {contacts.length} {contacts.length === 1 ? "contact" : "contacts"}
            </div>
          </div>

          <div className="overflow-x-auto">
            <div className="min-w-[920px]">
              <div className="grid grid-cols-[36%_22%_28%_14%] border-b border-[#eef2f4] text-left text-[13px] font-medium text-[var(--brand-text-muted)]">
                <HeaderCell label="Name" />
                <HeaderCell label="Phone" />
                <HeaderCell label="Address" />
                <HeaderCell label="Actions" align="right" />
              </div>

              <div className="max-h-[20rem] overflow-y-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
                {contacts.length === 0 ? (
                  <div className="px-5 py-10 text-center text-sm text-[var(--brand-text-muted)]">No contacts found for this tenant.</div>
                ) : (
                  contacts.map((contact) => (
                    <div
                      key={contact.id}
                      className="grid h-[68px] grid-cols-[36%_22%_28%_14%] border-b border-[#f1f4f7] text-sm text-[var(--brand-ink)] transition hover:bg-[#fafcfd] last:border-b-0"
                    >
                      <div className="flex items-center px-5">
                        <div className="flex items-center gap-3">
                          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[#cdeade] bg-[var(--brand-teal-soft)] text-xs font-semibold uppercase text-[#1a6b5a]">
                            {contact.name.slice(0, 2)}
                          </span>
                          <div className="min-w-0">
                            <p className="truncate font-semibold leading-tight text-[var(--brand-ink)]">{contact.name}</p>
                            <p className="truncate text-[13px] leading-tight text-[var(--brand-text-muted)]">
                              {firmNameById.get(contact.firm_id) ?? "—"} · {contact.email}
                            </p>
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center px-5">
                        <span className="inline-flex rounded-full border border-[var(--brand-border)] bg-[var(--brand-card)] px-2.5 py-1 text-xs font-medium text-[var(--brand-text-muted)]">
                          {contact.phone_number}
                        </span>
                      </div>

                      <div className="flex items-center px-5 text-[var(--brand-text-muted)]">
                        <span className="block truncate">{contact.address}</span>
                      </div>

                      <div className="relative flex items-center justify-end px-5">
                        <button
                          type="button"
                          data-contact-menu-trigger
                          aria-haspopup="menu"
                          aria-expanded={activeMenuContactId === contact.id}
                          onClick={() => {
                            setActiveMenuContactId((current) => (current === contact.id ? null : contact.id));
                          }}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-[var(--brand-border)] bg-[var(--brand-card)] text-[var(--brand-text-muted)] transition hover:border-[var(--brand-teal)] hover:text-[var(--brand-teal)]"
                        >
                          <MoreHorizontal size={15} />
                        </button>

                        {activeMenuContactId === contact.id ? (
                          <div data-contact-menu className="absolute right-5 top-[52px] z-20 w-28 rounded-lg border border-[var(--brand-border)] bg-[var(--brand-card)] p-1.5 shadow-lg shadow-slate-200/60">
                            <button
                              type="button"
                              onClick={() => openContactEditDialog(contact)}
                              className="flex w-full items-center justify-start rounded-md px-2.5 py-2 text-xs font-medium text-[var(--brand-ink)] transition hover:bg-[var(--brand-surface)]"
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                void handleDeleteContact(contact);
                              }}
                              disabled={deletingContactId === contact.id}
                              className="flex w-full items-center justify-start rounded-md px-2.5 py-2 text-xs font-medium text-[var(--brand-danger-text)] transition hover:bg-[var(--brand-danger-bg)]"
                            >
                              {deletingContactId === contact.id ? "Deleting..." : "Delete"}
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
