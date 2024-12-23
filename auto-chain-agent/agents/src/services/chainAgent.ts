import { ChatOpenAI } from "@langchain/openai";
import { StateGraph, Annotation, MemorySaver, START, END } from "@langchain/langgraph";
import { HumanMessage, BaseMessage, SystemMessage } from "@langchain/core/messages";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { blockchainTools } from './tools';
import { config } from "../config/index";
import logger from "../logger";
import { startWithHistory } from "./utils";
import { loadThreadSummary, startSummarySystem } from './thread/summarySystem';
import { createThreadStorage } from './thread/threadStorage';
import { ConversationState } from './thread/interface';
const StateAnnotation = Annotation.Root({
    messages: Annotation<BaseMessage[]>({
        reducer: (curr, prev) => [...curr, ...prev],
        default: () => [],
    }),
    toolCalls: Annotation<Array<{
        id: string;
        type: string;
        function: {
            name: string;
            arguments: string;
        };
        result?: string;
    }>>({
        reducer: (_, next) => next,
        default: () => [],
    })
});

const model = new ChatOpenAI({
    openAIApiKey: config.openaiApiKey,
    modelName: config.LLM_MODEL,
    temperature: config.TEMPERATURE,
}).bindTools(blockchainTools);

const threadStorage = createThreadStorage();
const checkpointer = new MemorySaver();
const toolNode = new ToolNode(blockchainTools);

const conversationState: ConversationState = {
    isInitialLoad: true,
    needsHistoryRebuild: false
};

const agentNode = async (state: typeof StateAnnotation.State) => {
    try {
        const systemMessage = new SystemMessage({
            content: `You are a friendly and helpful AI assistant. 
            - Engage naturally in conversation and remember details users share about themselves
            - When blockchain operations are needed, you can check balances and perform transactions`
        });

        if (conversationState.needsHistoryRebuild) {
            await startWithHistory().then(async () => {
                const prevMessages = (await loadThreadSummary())
                    .map((content: string) => new HumanMessage({ content }));
                state.messages = [...state.messages, ...prevMessages];
                conversationState.isInitialLoad = false;
            });
            conversationState.needsHistoryRebuild = false;
        }

        if (conversationState.isInitialLoad) {
            const prevMessages = (await loadThreadSummary())
                .map(content => new HumanMessage({ content }));
            state.messages = [...state.messages, ...prevMessages];
            conversationState.isInitialLoad = false;
        }

        const messages = [systemMessage, ...state.messages];
        const response = await model.invoke(messages);

        return { messages: [response] };
    } catch (error) {
        logger.error("Error in agent node:", error);
        throw error;
    }
};

const toolExecutionNode = async (state: typeof StateAnnotation.State) => {
    try {
        logger.info('Tool execution node - Starting tool execution');

        const lastMessage = state.messages[state.messages.length - 1];
        const toolCalls = lastMessage.additional_kwargs?.tool_calls || [];

        if (!toolCalls.length) {
            logger.info('No tool calls found');
            return { messages: [], toolCalls: [] };
        }

        const toolResponse = await toolNode.invoke({
            messages: state.messages
        });

        if (!toolResponse?.messages?.length) {
            logger.info('No tool response messages');
            return { messages: [], toolCalls: [] };
        }

        // Format tool calls with their results
        const formattedToolCalls = toolCalls.map((call: any, index: number) => ({
            id: call.id,
            type: call.type,
            function: {
                name: call.function.name,
                arguments: call.function.arguments
            },
            result: toolResponse.messages[index]?.content?.toString()
        }));

        return {
            messages: toolResponse.messages,
            toolCalls: formattedToolCalls
        };
    } catch (error) {
        logger.error("Error in tool execution:", error);
        return { messages: [], toolCalls: [] };
    }
};

const shouldContinue = (state: typeof StateAnnotation.State) => {
    const lastMessage = state.messages[state.messages.length - 1];
    if (lastMessage._getType() === 'ai') {
        const toolCalls = lastMessage.additional_kwargs?.tool_calls || [];
        return toolCalls.length > 0 ? 'tools' : END;
    }
    return 'agent';
};

const createBlockchainGraph = async () => {
    try {
        return new StateGraph(StateAnnotation)
            .addNode("agent", agentNode)
            .addNode("tools", toolExecutionNode)
            .addEdge(START, "agent")
            .addConditionalEdges("agent", shouldContinue)
            .addEdge("tools", "agent")
            .compile({ checkpointer });
    } catch (error) {
        logger.error("Failed to create blockchain graph:", error);
        throw error;
    }
};

let agentGraph: Awaited<ReturnType<typeof createBlockchainGraph>>;
(async () => {
    try {
        agentGraph = await createBlockchainGraph();
        await startSummarySystem();
        logger.info('Blockchain agent and summary system initialized successfully');
    } catch (error) {
        logger.error('Failed to initialize blockchain agent:', error);
    }
})();

export const blockchainAgent = {
    async handleMessage({ message, threadId }: { message: string; threadId?: string }) {
        try {
            if (!agentGraph) {
                throw new Error("Blockchain agent not initialized");
            }

            const currentThreadId = threadId || `blockchain_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
            const previousState = threadId ? await threadStorage.loadThread(threadId) : null;
            
            let relevantContext: BaseMessage[] = [];
            if (!previousState || previousState.messages.length <= 2) {
                const summaries = await loadThreadSummary();
                if (summaries.length > 0) {
                    relevantContext = [new SystemMessage({
                        content: `Previous conversations context: ${
                            summaries
                                .slice(0, 100)
                                .map(summary => summary.trim())
                                .join(' | ')
                        }`
                    })];
                }
            }
            logger.info(`Relevant context: ${relevantContext}`);
            const initialState = {
                messages: previousState ? [
                    ...previousState.messages,
                    new HumanMessage({ content: message })
                ] : [
                    ...relevantContext,
                    new SystemMessage({
                        content: `
                        You are a helpful AI assistant.
                        You can engage in general conversation and also help with blockchain operations like checking balances and performing transactions.`
                    }),
                    new HumanMessage({ content: message })
                ]
            } as typeof StateAnnotation.State;

            const result = await agentGraph.invoke(initialState, {
                configurable: { thread_id: currentThreadId }
            });

            const lastMessage = result.messages[result.messages.length - 1];
            const response = typeof lastMessage.content === 'object'
                ? JSON.stringify(lastMessage.content, null, 2)
                : lastMessage.content;

            await threadStorage.saveThread(currentThreadId, {
                messages: result.messages,
                toolCalls: result.toolCalls || []
            });

            return {
                threadId: currentThreadId,
                response,
                toolCalls: result.toolCalls || []
            };
        } catch (error) {
            logger.error("Error handling message:", error);
            throw error;
        }
    },

    async getThreadState(threadId: string) {
        return await threadStorage.loadThread(threadId);
    }
}; 