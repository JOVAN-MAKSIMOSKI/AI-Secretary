import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import SessionBootstrap from "./components/shared/SessionBootstrap";
import PortalLayout from "./layouts/PortalLayout";
import Callback from "./pages/auth/Callback";
import Login from "./pages/auth/Login";
import SignUp from "./pages/auth/SignUp";
import PortalCalendar from "./pages/portal/Calendar.tsx";
import PortalParties from "./pages/portal/Parties";
import PortalDashboard from "./pages/portal/Dashboard";
import PortalDocuments from "./pages/portal/Documents";
import PortalContact from "./pages/portal/Contact";
import PortalLawQuestions from "./pages/portal/LawQuestions";
import PortalSettings from "./pages/portal/Settings";
import { PublicOnly, RequireAuth } from "./router/guards";

export default function App() {
  return (
    <BrowserRouter>
      <SessionBootstrap />
      <Routes>
        <Route path="/" element={<Navigate to="/login" replace />} />
        <Route
          path="/login"
          element={
            <PublicOnly>
              <Login />
            </PublicOnly>
          }
        />
        <Route
          path="/signup"
          element={
            <PublicOnly>
              <SignUp />
            </PublicOnly>
          }
        />
        <Route path="/callback" element={<Callback />} />
        <Route
          path="/portal"
          element={
            <RequireAuth>
              <PortalLayout />
            </RequireAuth>
          }
        >
          <Route index element={<Navigate to="dashboard" replace />} />
          <Route path="dashboard" element={<PortalDashboard />} />
          <Route path="parties" element={<PortalParties />} />
          <Route path="documents" element={<PortalDocuments />} />
          <Route path="calendar" element={<PortalCalendar />} />
          <Route path="contact" element={<PortalContact />} />
          <Route path="law-questions" element={<PortalLawQuestions />} />
          <Route path="settings" element={<PortalSettings />} />
        </Route>
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
