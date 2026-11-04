"use client";

import { useEffect, useMemo, useState } from "react";
import type { FormEvent, ReactNode } from "react";

type RequestStatus = "Pendiente" | "Autorizada" | "Rechazada" | "Cancelada";
type RequestRecord = {
  id: string;
  student: string;
  group: string;
  pickupPerson: string;
  relationship: string;
  time: string;
  status: RequestStatus;
  initials: string;
};

const initialRequests: RequestRecord[] = [
  {
    id: "AL-1048",
    student: "Valentina Cruz",
    group: "3.º B",
    pickupPerson: "Mariana Cruz",
    relationship: "Tía",
    time: "12:42",
    status: "Pendiente",
    initials: "VC",
  },
  {
    id: "AL-1047",
    student: "Diego Herrera",
    group: "5.º A",
    pickupPerson: "Arturo Herrera",
    relationship: "Abuelo",
    time: "12:36",
    status: "Autorizada",
    initials: "DH",
  },
  {
    id: "AL-1046",
    student: "Camila Ríos",
    group: "2.º C",
    pickupPerson: "Sofía Ríos",
    relationship: "Madre",
    time: "12:28",
    status: "Pendiente",
    initials: "CR",
  },
  {
    id: "AL-1045",
    student: "Mateo Salas",
    group: "6.º A",
    pickupPerson: "Jorge Salas",
    relationship: "Padre",
    time: "12:15",
    status: "Rechazada",
    initials: "MS",
  },
  {
    id: "AL-1044",
    student: "Lucía Ortega",
    group: "1.º B",
    pickupPerson: "Renata Ortega",
    relationship: "Tía",
    time: "11:58",
    status: "Autorizada",
    initials: "LO",
  },
];

const navItems = [
  { label: "Resumen", icon: "grid" },
  { label: "Autorizaciones", icon: "check", count: "4" },
  { label: "Alumnos", icon: "users" },
  { label: "Contactos", icon: "contact" },
  { label: "Personal", icon: "staff" },
  { label: "Reportes", icon: "chart" },
] as const;

type IconName =
  | "grid"
  | "check"
  | "users"
  | "contact"
  | "staff"
  | "chart"
  | "search"
  | "plus"
  | "arrow"
  | "clock"
  | "bell"
  | "close"
  | "calendar"
  | "chevron";

function Icon({
  name,
  size = 18,
}: {
  name: IconName;
  size?: number;
}) {
  const paths: Record<IconName, ReactNode> = {
    grid: (
      <>
        <rect x="3.5" y="3.5" width="7" height="7" rx="1.3" />
        <rect x="13.5" y="3.5" width="7" height="7" rx="1.3" />
        <rect x="3.5" y="13.5" width="7" height="7" rx="1.3" />
        <rect x="13.5" y="13.5" width="7" height="7" rx="1.3" />
      </>
    ),
    check: (
      <>
        <path d="M8 5H5.5A2.5 2.5 0 0 0 3 7.5v11A2.5 2.5 0 0 0 5.5 21h13a2.5 2.5 0 0 0 2.5-2.5V12" />
        <path d="m8 12 3 3L21 5" />
      </>
    ),
    users: (
      <>
        <path d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
        <circle cx="10" cy="7" r="4" />
        <path d="M20 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
      </>
    ),
    contact: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <circle cx="9" cy="10" r="2.5" />
        <path d="M5.5 17a3.5 3.5 0 0 1 7 0M15 9h3M15 13h3M15 17h3" />
      </>
    ),
    staff: (
      <>
        <path d="M12 3 4 7v5c0 5 3.4 8.5 8 10 4.6-1.5 8-5 8-10V7l-8-4Z" />
        <path d="m9 12 2 2 4-4" />
      </>
    ),
    chart: (
      <>
        <path d="M4 19V5M4 19h17" />
        <path d="m7 15 4-4 3 2 6-7" />
      </>
    ),
    search: (
      <>
        <circle cx="10.8" cy="10.8" r="6.8" />
        <path d="m16 16 4.5 4.5" />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    arrow: (
      <>
        <path d="M5 12h14" />
        <path d="m13 6 6 6-6 6" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    bell: (
      <>
        <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
        <path d="M10 21h4" />
      </>
    ),
    close: <path d="m18 6-12 12M6 6l12 12" />,
    calendar: (
      <>
        <rect x="3" y="5" width="18" height="16" rx="2" />
        <path d="M16 3v4M8 3v4M3 10h18" />
      </>
    ),
    chevron: <path d="m7 10 5 5 5-5" />,
  };

  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name]}
    </svg>
  );
}

function StatusBadge({ status }: { status: RequestStatus }) {
  const className = status.toLowerCase();
  return <span className={`status-badge ${className}`}>{status}</span>;
}

export default function Home() {
  const [requests, setRequests] = useState(initialRequests);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("Todas");
  const [selectedRequest, setSelectedRequest] = useState<RequestRecord | null>(
    null,
  );
  const [showForm, setShowForm] = useState(false);
  const [notice, setNotice] = useState("");
  const [activeNav, setActiveNav] = useState("Resumen");

  useEffect(() => {
    if (!showForm && !selectedRequest) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setShowForm(false);
        setSelectedRequest(null);
      }
    }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [selectedRequest, showForm]);

  const visibleRequests = useMemo(() => {
    const normalized = search.trim().toLocaleLowerCase("es-MX");
    return requests.filter((request) => {
      const matchesFilter = filter === "Todas" || request.status === filter;
      const matchesSearch =
        !normalized ||
        `${request.student} ${request.pickupPerson} ${request.id}`
          .toLocaleLowerCase("es-MX")
          .includes(normalized);
      return matchesFilter && matchesSearch;
    });
  }, [filter, requests, search]);

  const pendingCount = requests.filter(
    (request) => request.status === "Pendiente",
  ).length;
  const authorizedCount = requests.filter(
    (request) => request.status === "Autorizada",
  ).length;

  function createDemoRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const student = String(formData.get("student")).trim();
    const pickupPerson = String(formData.get("pickupPerson")).trim();
    const relationship = String(formData.get("relationship")).trim();
    const initials = student
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toLocaleUpperCase("es-MX");
    const newRequest: RequestRecord = {
      id: `AL-${1049 + requests.length - initialRequests.length}`,
      student,
      group: "3.º A",
      pickupPerson,
      relationship,
      time: new Intl.DateTimeFormat("es-MX", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date()),
      status: "Pendiente",
      initials,
    };
    setRequests((current) => [newRequest, ...current]);
    setShowForm(false);
    setFilter("Todas");
    setSearch("");
    setNotice("Solicitud de demostración agregada; no se envió a la API.");
    window.setTimeout(() => setNotice(""), 4500);
  }

  function cancelDemoRequest(requestId: string) {
    setRequests((current) =>
      current.map((request) =>
        request.id === requestId
          ? { ...request, status: "Cancelada" }
          : request,
      ),
    );
    setSelectedRequest((current) =>
      current?.id === requestId
        ? { ...current, status: "Cancelada" }
        : current,
    );
    setNotice("Cambio aplicado solo a los datos de demostración.");
    window.setTimeout(() => setNotice(""), 4500);
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#" aria-label="AulaLink, inicio">
          <span className="brand-mark">A</span>
          <span className="brand-copy">
            <strong>AulaLink</strong>
            <small>GESTIÓN ESCOLAR</small>
          </span>
        </a>

        <div className="school-switcher">
          <span className="school-emblem">IH</span>
          <span className="school-copy">
            <strong>Instituto Horizonte</strong>
            <small>Ciclo 2026–2027</small>
          </span>
          <Icon name="chevron" size={15} />
        </div>

        <p className="nav-heading">ADMINISTRACIÓN</p>
        <nav className="main-nav" aria-label="Navegación principal">
          {navItems.map((item) => (
            <button
              className={`nav-link ${activeNav === item.label ? "selected" : ""}`}
              key={item.label}
              disabled={!["Resumen", "Autorizaciones"].includes(item.label)}
              onClick={() => {
                setActiveNav(item.label);
                setFilter(item.label === "Autorizaciones" ? "Pendiente" : "Todas");
              }}
              type="button"
              title={
                ["Resumen", "Autorizaciones"].includes(item.label)
                  ? undefined
                  : "Sección de demostración no disponible"
              }
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
              {"count" in item && (
                <span className="nav-count">{pendingCount || item.count}</span>
              )}
            </button>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="support-note">
            <span className="support-line" />
            <div>
              <strong>¿Necesitas ayuda?</strong>
              <span>Consulta la guía de uso</span>
            </div>
            <Icon name="arrow" size={15} />
          </div>
          <div className="profile">
            <span className="profile-avatar">CM</span>
            <span className="profile-copy">
              <strong>Coordinación</strong>
              <small>Administración escolar</small>
            </span>
            <button className="profile-menu" aria-label="Opciones de perfil">
              <span />
              <span />
              <span />
            </button>
          </div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumb">
            <span>Instituto Horizonte</span>
            <span className="breadcrumb-divider">/</span>
            <strong>{activeNav}</strong>
          </div>
          <div className="topbar-actions">
            <span className="today-label">
              <Icon name="calendar" size={16} />
              <span>
                {new Intl.DateTimeFormat("es-MX", {
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                }).format(new Date())}
              </span>
            </span>
            <span className="icon-button notification-button" aria-label="Notificaciones de demostración">
              <Icon name="bell" />
              <span className="notification-dot" />
            </span>
            <span className="topbar-avatar">CM</span>
          </div>
        </header>

        <div className="content-wrap">
          <div className="demo-banner" role="note">
            <span className="demo-banner-mark">i</span>
            <span>
              <strong>Vista de demostración</strong>
              <span className="demo-separator">·</span>
              Datos ficticios; no conectado a la API ni protegido por inicio de
              sesión.
            </span>
            <span className="demo-banner-label">SOLO PRESENTACIÓN</span>
          </div>

          <section className="page-heading">
            <div>
              <p className="eyebrow">JORNADA ESCOLAR · CICLO 2026–2027</p>
              <h1>Un día bajo control.</h1>
              <p className="heading-subtitle">
                Aquí tienes lo que necesita atención en el Instituto Horizonte.
              </p>
            </div>
            <button
              className="primary-button"
              onClick={() => setShowForm(true)}
              type="button"
            >
              <Icon name="plus" size={18} />
              Nueva solicitud
            </button>
          </section>

          <section className="metrics" aria-label="Resumen de la jornada">
            <article className="metric-item metric-attention">
              <div className="metric-top">
                <span className="metric-label">Por confirmar</span>
                <span className="metric-icon amber">
                  <Icon name="clock" size={18} />
                </span>
              </div>
              <strong className="metric-value">{pendingCount}</strong>
              <span className="metric-foot">
                <span className="metric-dot amber-dot" />
                Requieren respuesta del tutor
              </span>
            </article>
            <article className="metric-item">
              <div className="metric-top">
                <span className="metric-label">Autorizadas hoy</span>
                <span className="metric-icon green">
                  <Icon name="check" size={18} />
                </span>
              </div>
              <strong className="metric-value">{authorizedCount + 18}</strong>
              <span className="metric-foot">De 22 solicitudes recibidas</span>
            </article>
            <article className="metric-item">
              <div className="metric-top">
                <span className="metric-label">Alumnos en jornada</span>
                <span className="metric-icon blue">
                  <Icon name="users" size={18} />
                </span>
              </div>
              <strong className="metric-value">286</strong>
              <span className="metric-foot">Asistencia registrada al día</span>
            </article>
            <article className="metric-item">
              <div className="metric-top">
                <span className="metric-label">Personal activo</span>
                <span className="metric-icon slate">
                  <Icon name="staff" size={18} />
                </span>
              </div>
              <strong className="metric-value">24</strong>
              <span className="metric-foot">En 3 áreas de supervisión</span>
            </article>
          </section>

          <section className="attention-strip">
            <span className="attention-icon">
              <Icon name="clock" size={18} />
            </span>
            <span className="attention-copy">
              <strong>{pendingCount} solicitudes esperan confirmación</strong>
              <span>
                Verifica la respuesta del tutor antes de autorizar cualquier
                entrega.
              </span>
            </span>
            <button
              className="text-button"
              onClick={() => {
                setFilter("Pendiente");
                setActiveNav("Autorizaciones");
              }}
              type="button"
            >
              Revisar pendientes <Icon name="arrow" size={16} />
            </button>
          </section>

          <div className="dashboard-grid">
            <section className="requests-panel">
              <div className="panel-heading">
                <div>
                  <div className="panel-title-row">
                    <h2>Autorizaciones de salida</h2>
                    <span className="table-count">{requests.length}</span>
                  </div>
                  <p>Seguimiento de solicitudes registradas hoy</p>
                </div>
                <button
                  className="subtle-link"
                  onClick={() => {
                    setSearch("");
                    setFilter("Todas");
                  }}
                  type="button"
                >
                  Ver todas <Icon name="arrow" size={15} />
                </button>
              </div>

              <div className="table-tools">
                <label className="search-field">
                  <Icon name="search" size={17} />
                  <input
                    aria-label="Buscar alumno o persona autorizada"
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Buscar alumno o persona..."
                    value={search}
                  />
                  <kbd>⌘ K</kbd>
                </label>
                <label className="filter-field">
                  <span className="sr-only">Filtrar por estado</span>
                  <select
                    onChange={(event) => setFilter(event.target.value)}
                    value={filter}
                  >
                    <option>Todas</option>
                    <option>Pendiente</option>
                    <option>Autorizada</option>
                    <option>Rechazada</option>
                    <option>Cancelada</option>
                  </select>
                  <Icon name="chevron" size={14} />
                </label>
              </div>

              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>ALUMNO</th>
                      <th>PERSONA QUE RECOGE</th>
                      <th>HORA</th>
                      <th>ESTADO</th>
                      <th>
                        <span className="sr-only">Detalle</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRequests.map((request) => (
                      <tr key={request.id}>
                        <td>
                          <div className="student-cell">
                            <span className="student-avatar">
                              {request.initials}
                            </span>
                            <span>
                              <strong>{request.student}</strong>
                              <small>
                                {request.group} <span>·</span> {request.id}
                              </small>
                            </span>
                          </div>
                        </td>
                        <td>
                          <span className="pickup-name">
                            {request.pickupPerson}
                          </span>
                          <small className="relationship">
                            {request.relationship}
                          </small>
                        </td>
                        <td className="time-cell">{request.time}</td>
                        <td>
                          <StatusBadge status={request.status} />
                        </td>
                        <td>
                          <button
                            aria-label={`Ver solicitud ${request.id}`}
                            className="row-action"
                            onClick={() => setSelectedRequest(request)}
                            type="button"
                          >
                            <Icon name="arrow" size={16} />
                          </button>
                        </td>
                      </tr>
                    ))}
                    {visibleRequests.length === 0 && (
                      <tr>
                        <td className="empty-row" colSpan={5}>
                          No hay solicitudes que coincidan con la búsqueda.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="table-footer">
                <span>
                  Mostrando <strong>{visibleRequests.length}</strong> de{" "}
                  <strong>{requests.length}</strong> solicitudes
                </span>
                <button
                  className="subtle-link"
                  onClick={() => {
                    setSearch("");
                    setFilter("Todas");
                  }}
                  type="button"
                >
                  Restablecer filtros
                </button>
              </div>
            </section>

            <aside className="activity-panel">
              <div className="panel-heading activity-heading">
                <div>
                  <h2>Actividad reciente</h2>
                  <p>Movimientos de hoy</p>
                </div>
                <span className="icon-button small-icon-button" aria-label="Más opciones">
                  <span className="more-dots">···</span>
                </span>
              </div>

              <div className="timeline">
                <article className="timeline-item">
                  <span className="timeline-marker success">
                    <Icon name="check" size={14} />
                  </span>
                  <div>
                    <p>
                      <strong>Solicitud autorizada</strong>
                    </p>
                    <span>Diego Herrera · 5.º A</span>
                    <small>Hace 6 minutos</small>
                  </div>
                </article>
                <article className="timeline-item">
                  <span className="timeline-marker pending">
                    <Icon name="clock" size={14} />
                  </span>
                  <div>
                    <p>
                      <strong>Confirmación solicitada</strong>
                    </p>
                    <span>Valentina Cruz · 3.º B</span>
                    <small>Hace 10 minutos</small>
                  </div>
                </article>
                <article className="timeline-item">
                  <span className="timeline-marker neutral">
                    <Icon name="users" size={14} />
                  </span>
                  <div>
                    <p>
                      <strong>Asistencia actualizada</strong>
                    </p>
                    <span>Registro de primaria</span>
                    <small>Hace 18 minutos</small>
                  </div>
                </article>
                <article className="timeline-item">
                  <span className="timeline-marker success">
                    <Icon name="check" size={14} />
                  </span>
                  <div>
                    <p>
                      <strong>Solicitud autorizada</strong>
                    </p>
                    <span>Lucía Ortega · 1.º B</span>
                    <small>Hace 24 minutos</small>
                  </div>
                </article>
              </div>
              <span className="activity-link">
                Consultar bitácora <Icon name="arrow" size={15} />
              </span>

              <div className="daily-note">
                <div className="daily-note-top">
                  <span className="daily-note-icon">
                    <Icon name="calendar" size={16} />
                  </span>
                  <span className="daily-note-date">
                    HOY ·{" "}
                    {new Intl.DateTimeFormat("es-MX", {
                      day: "numeric",
                      month: "short",
                    })
                      .format(new Date())
                      .toLocaleUpperCase("es-MX")}
                  </span>
                </div>
                <strong>Salida de primaria</strong>
                <p>El acceso norte estará habilitado a partir de las 13:00 h.</p>
              </div>
            </aside>
          </div>

          <footer className="page-footer">
            <span>AulaLink <span>·</span> Gestión escolar</span>
            <span>Entorno de demostración · Información ficticia</span>
          </footer>
        </div>
      </main>

      {notice && (
        <div className="toast" role="status">
          <span className="toast-check">
            <Icon name="check" size={15} />
          </span>
          {notice}
        </div>
      )}

      {(showForm || selectedRequest) && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setShowForm(false);
              setSelectedRequest(null);
            }
          }}
        >
          <section
            aria-labelledby="modal-title"
            aria-modal="true"
            className="modal"
            role="dialog"
          >
            <div className="modal-heading">
              <div>
                <span className="modal-kicker">
                  {showForm ? "NUEVA SOLICITUD" : selectedRequest?.id}
                </span>
                <h2 id="modal-title">
                  {showForm ? "Registrar recogida" : "Detalle de autorización"}
                </h2>
              </div>
              <button
                aria-label="Cerrar ventana"
                autoFocus={!showForm}
                className="icon-button close-button"
                onClick={() => {
                  setShowForm(false);
                  setSelectedRequest(null);
                }}
                type="button"
              >
                <Icon name="close" />
              </button>
            </div>

            {showForm ? (
              <form className="request-form" onSubmit={createDemoRequest}>
                <p className="form-disclaimer">
                  Formulario de muestra. Al guardar, solo se modifica la lista
                  ficticia en esta pantalla.
                </p>
                <label>
                  Alumno
                  <input
                    autoComplete="off"
                    autoFocus
                    maxLength={100}
                    name="student"
                    placeholder="Nombre del alumno"
                    required
                  />
                </label>
                <label>
                  Nombre de quien recoge
                  <input
                    autoComplete="off"
                    maxLength={100}
                    name="pickupPerson"
                    placeholder="Nombre completo"
                    required
                  />
                </label>
                <label>
                  Relación con el alumno
                  <select defaultValue="" name="relationship" required>
                    <option disabled value="">
                      Selecciona una opción
                    </option>
                    <option>Familiar</option>
                    <option>Abuela / Abuelo</option>
                    <option>Tía / Tío</option>
                    <option>Otra persona autorizada</option>
                  </select>
                </label>
                <div className="form-note">
                  <Icon name="clock" size={17} />
                  La entrega real siempre requiere confirmación del tutor legal.
                </div>
                <div className="modal-actions">
                  <button
                    className="secondary-button"
                    onClick={() => setShowForm(false)}
                    type="button"
                  >
                    Cerrar
                  </button>
                  <button className="primary-button" type="submit">
                    Agregar a la demo
                  </button>
                </div>
              </form>
            ) : (
              selectedRequest && (
                <div className="request-detail">
                  <div className="detail-state">
                    <span>ESTADO ACTUAL</span>
                    <StatusBadge status={selectedRequest.status} />
                  </div>
                  <dl>
                    <div>
                      <dt>Alumno</dt>
                      <dd>{selectedRequest.student}</dd>
                      <small>{selectedRequest.group}</small>
                    </div>
                    <div>
                      <dt>Persona que recoge</dt>
                      <dd>{selectedRequest.pickupPerson}</dd>
                      <small>{selectedRequest.relationship}</small>
                    </div>
                    <div>
                      <dt>Registro</dt>
                      <dd>Hoy, {selectedRequest.time}</dd>
                    </div>
                    <div>
                      <dt>Folio</dt>
                      <dd>{selectedRequest.id}</dd>
                    </div>
                  </dl>
                  <p className="detail-disclaimer">
                    Información de demostración. La confirmación del tutor y la
                    auditoría real aún no están conectadas.
                  </p>
                  {selectedRequest.status === "Pendiente" && (
                    <div className="modal-actions">
                      <button
                        className="secondary-button"
                        onClick={() => setSelectedRequest(null)}
                        type="button"
                      >
                        Cerrar
                      </button>
                      <button
                        className="danger-button"
                        onClick={() => cancelDemoRequest(selectedRequest.id)}
                        type="button"
                      >
                        Simular cancelación
                      </button>
                    </div>
                  )}
                </div>
              )
            )}
          </section>
        </div>
      )}
    </div>
  );
}
