// agent-provide — supply a value to a process paused on a human-input request
// (verification code, password, …). The supervising agent runs this after
// seeing a ⟨NEED-INPUT⟩ marker from a backgrounded automation.
export { provideHumanInput, readPendingRequest } from '../../shared/agent/human-input.js';
