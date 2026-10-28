const nativeRunners = new WeakMap<
	object,
	{ controller: MemoryConversationController; viewOwner?: object; rebindView?: () => void }
>();
const nativeContexts = new WeakMap<object, MemoryConversation>();

export function getMemoryConversation(context: object): MemoryConversation | undefined {
	return nativeContexts.get(context);
}

export function bindNativeMemoryConversationRunner(runner: object, controller: MemoryConversationController): void {
	nativeRunners.set(runner, { controller });
}

export function bindNativeMemoryConversationView(
	runner: object,
	viewOwner: object,
	view: NativeMemoryConversationView,
	rebindView: () => void,
): ((originalText: string, submittedText: string) => object | undefined) | undefined {
	const binding = nativeRunners.get(runner);
	if (!binding) return undefined;
	binding.viewOwner = viewOwner;
	binding.rebindView = rebindView;
	return binding.controller.bindView(view);
}

export function invalidateNativeMemoryConversationView(runner: object, viewOwner: object | undefined): void {
	const binding = nativeRunners.get(runner);
	if (viewOwner && binding?.viewOwner === viewOwner) binding.controller.invalidate();
}

export function unbindNativeMemoryConversationView(runner: object, viewOwner: object | undefined): void {
	const binding = nativeRunners.get(runner);
	if (!viewOwner || binding?.viewOwner !== viewOwner) return;
	delete binding.viewOwner;
	delete binding.rebindView;
	binding.controller.invalidate();
}

export function bindNativeMemoryConversationContext(context: object, runner: object, owner: object): void {
	const binding = nativeRunners.get(runner);
	if (!binding) return;
	if (!binding.controller.isViewBound) binding.rebindView?.();
	if (nativeRunners.get(runner) !== binding) return;
	nativeContexts.set(context, binding.controller.forTool(owner));
}

export function revokeNativeMemoryConversationRunner(runner: object): void {
	const binding = nativeRunners.get(runner);
	nativeRunners.delete(runner);
	binding?.controller.invalidate();
}

export interface MemoryConversationProposal {
	readonly id: string;
	readonly text: string;
}

export interface MemoryConversationReply {
	readonly proposalId: string;
	readonly originalText: string;
	readonly submittedText: string;
}

export interface MemoryConversation {
	present(proposal: MemoryConversationProposal): MemoryConversationProposal | undefined;
	resolveReply(proposalId: string): MemoryConversationReply | undefined;
}

export interface NativeMemoryConversationView {
	isActive(): boolean;
	present(proposal: MemoryConversationProposal): (() => boolean) | undefined;
}

interface PendingProposal {
	readonly owner: object;
	readonly proposal: MemoryConversationProposal;
	readonly isInstalled: () => boolean;
}

interface NativeInput {
	readonly pending: PendingProposal;
	readonly originalText: string;
	readonly submittedText: string;
}

export class MemoryConversationController {
	#view: NativeMemoryConversationView | undefined;
	#generation = 0;
	#presentation = 0;
	#pending: PendingProposal | undefined;
	#reply: NativeInput | undefined;
	#inputs = new WeakMap<object, NativeInput>();
	#messages = new WeakMap<object, NativeInput>();
	#activatedMessages = new WeakSet<object>();

	get isViewBound(): boolean {
		const view = this.#view;
		const generation = this.#generation;
		try {
			return view?.isActive() === true && view === this.#view && generation === this.#generation;
		} catch {
			return false;
		}
	}

	bindView(view: NativeMemoryConversationView): (originalText: string, submittedText: string) => object | undefined {
		this.invalidate();
		this.#view = view;
		const generation = this.#generation;
		return (originalText, submittedText) => {
			const pending = this.#pending;
			if (generation !== this.#generation || !pending || !this.#isCurrent(pending)) return undefined;
			const token = Object.freeze({});
			this.#inputs.set(token, { pending, originalText, submittedText });
			return token;
		};
	}

	forTool(owner: object): MemoryConversation {
		const generation = this.#generation;
		return Object.freeze({
			present: (proposal: MemoryConversationProposal) => this.#present(owner, generation, proposal),
			resolveReply: (proposalId: string) => this.#resolve(owner, generation, proposalId),
		});
	}

	associateInput(message: object, token: unknown, submittedText: string): void {
		if (typeof token !== "object" || token === null) return;
		const input = this.#inputs.get(token);
		this.#inputs.delete(token);
		if (
			!input ||
			this.#activatedMessages.has(message) ||
			input.submittedText !== submittedText ||
			!this.#isCurrent(input.pending)
		)
			return;
		this.#messages.set(message, input);
	}

	activateInput(message: object): void {
		this.#reply = undefined;
		const input = this.#messages.get(message);
		this.#messages.delete(message);
		if (this.#activatedMessages.has(message)) return;
		this.#activatedMessages.add(message);
		if (input && this.#isCurrent(input.pending)) this.#reply = input;
	}

	invalidate(): void {
		this.#generation++;
		this.#presentation++;
		this.#view = undefined;
		this.#clearProposal();
	}

	#present(
		owner: object,
		generation: number,
		proposal: MemoryConversationProposal,
	): MemoryConversationProposal | undefined {
		if (
			generation !== this.#generation ||
			typeof proposal?.id !== "string" ||
			proposal.id.length === 0 ||
			typeof proposal.text !== "string" ||
			proposal.text.length === 0
		) {
			return undefined;
		}
		const view = this.#view;
		if (!view) return undefined;
		const presentation = ++this.#presentation;
		this.#clearProposal();
		const snapshot = Object.freeze({ id: proposal.id, text: proposal.text });
		try {
			if (!view.isActive()) return undefined;
			const isInstalled = view.present(snapshot);
			if (
				typeof isInstalled !== "function" ||
				!view.isActive() ||
				!isInstalled() ||
				generation !== this.#generation ||
				presentation !== this.#presentation ||
				view !== this.#view
			) {
				return undefined;
			}
			this.#pending = { owner, proposal: snapshot, isInstalled };
			return snapshot;
		} catch {
			return undefined;
		}
	}

	#resolve(owner: object, generation: number, proposalId: string): MemoryConversationReply | undefined {
		const pending = this.#pending;
		const input = this.#reply;
		if (
			generation !== this.#generation ||
			!pending ||
			pending.owner !== owner ||
			pending.proposal.id !== proposalId ||
			input?.pending !== pending ||
			!this.#isCurrent(pending)
		) {
			return undefined;
		}
		this.#clearProposal();
		return Object.freeze({
			proposalId: pending.proposal.id,
			originalText: input.originalText,
			submittedText: input.submittedText,
		});
	}

	#isCurrent(pending: PendingProposal | undefined): boolean {
		const view = this.#view;
		const generation = this.#generation;
		if (!pending || pending !== this.#pending || !view) return false;
		try {
			const isCurrent =
				view.isActive() &&
				pending.isInstalled() &&
				view === this.#view &&
				generation === this.#generation &&
				pending === this.#pending;
			if (!isCurrent && pending === this.#pending) this.#clearProposal();
			return isCurrent;
		} catch {
			if (pending === this.#pending) this.#clearProposal();
			return false;
		}
	}

	#clearProposal(): void {
		this.#pending = undefined;
		this.#reply = undefined;
		this.#inputs = new WeakMap();
		this.#messages = new WeakMap();
	}
}
