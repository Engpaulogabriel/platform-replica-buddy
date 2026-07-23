import { createContext, useContext, useState, type ReactNode } from "react";

type Plan = "pro" | "lite";

interface PlanContextType {
  plan: Plan;
  setPlan: (p: Plan) => void;
  isPro: boolean;
  maxPumps: number;
}

const PlanContext = createContext<PlanContextType>({
  plan: "pro",
  setPlan: () => {},
  isPro: true,
  maxPumps: 999,
});

export function PlanProvider({ children }: { children: ReactNode }) {
  const [plan, setPlan] = useState<Plan>(() => {
    const saved = localStorage.getItem("app_plan");
    return (saved === "lite" ? "lite" : "pro") as Plan;
  });

  const handleSetPlan = (p: Plan) => {
    setPlan(p);
    localStorage.setItem("app_plan", p);
  };

  const isPro = plan === "pro";
  const maxPumps = isPro ? 999 : 4;

  return (
    <PlanContext.Provider value={{ plan, setPlan: handleSetPlan, isPro, maxPumps }}>
      {children}
    </PlanContext.Provider>
  );
}

export const usePlan = () => useContext(PlanContext);
