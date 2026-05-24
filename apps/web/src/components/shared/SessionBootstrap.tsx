import { useSession } from "../../hooks/useSession";

export default function SessionBootstrap() {
  useSession();
  return null;
}
