import { useState } from "react";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import interactionPlugin from "@fullcalendar/interaction";
import type { DateSelectArg, EventClickArg, EventInput } from "@fullcalendar/core";

const initialEvents: EventInput[] = [
  {
    id: "event-1",
    title: "Client Follow-up",
    start: new Date().toISOString().slice(0, 10),
  },
  {
    id: "event-2",
    title: "Invoice Review",
    start: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
  },
];

export default function Calendar() {
  const [events, setEvents] = useState<EventInput[]>(initialEvents);

  const handleDateSelect = (selectionInfo: DateSelectArg) => {
    const title = window.prompt("New event title");
    const calendarApi = selectionInfo.view.calendar;
    calendarApi.unselect();

    if (!title?.trim()) {
      return;
    }

    setEvents((current) => [
      ...current,
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        title: title.trim(),
        start: selectionInfo.startStr,
        end: selectionInfo.endStr,
        allDay: selectionInfo.allDay,
      },
    ]);
  };

  const handleEventClick = (clickInfo: EventClickArg) => {
    const shouldDelete = window.confirm(`Delete event \"${clickInfo.event.title}\"?`);
    if (!shouldDelete) {
      return;
    }

    setEvents((current) => current.filter((event) => event.id !== clickInfo.event.id));
  };

  return (
    <section className="m-2 h-full md:m-3">
      <div className="h-full rounded-2xl border border-slate-200 bg-white p-3 shadow-[0_14px_40px_-28px_rgba(15,23,42,0.6)] md:p-4">
        <h1 className="mb-3 text-lg font-semibold text-slate-900">Calendar</h1>

        <div className="h-[calc(100%-2.25rem)] min-h-[520px] rounded-xl border border-slate-200 bg-slate-50/40 p-2">
          <FullCalendar
            plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
            initialView="dayGridMonth"
            headerToolbar={{
              left: "prev,next today",
              center: "title",
              right: "dayGridMonth,timeGridWeek,timeGridDay",
            }}
            events={events}
            selectable
            selectMirror
            dayMaxEvents
            height="100%"
            select={handleDateSelect}
            eventClick={handleEventClick}
          />
        </div>
      </div>
    </section>
  );
}
