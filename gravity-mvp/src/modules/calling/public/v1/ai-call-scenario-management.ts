// Versioned Calling facade for Configuration-owned scenario-management routes.
// Persistence remains in the existing Calling-owned scenario repository.
export {
    createScenario,
    deleteScenario,
    getScenario,
    listProjects,
    listScenarios,
    updateScenario,
    type AiCallProjectConfig,
    type AiCallScenarioWithProject,
} from '@/lib/ai-call/scenarios'
