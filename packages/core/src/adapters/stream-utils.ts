/**
 * Shared utilities for Claude stream-json event parsing.
 */

/**
 * Extract displayable text from a Claude stream-json event.
 * Skips 'result' events — those duplicate the final assistant message.
 */
export function extractEventText(json: any): string | null {
    if (json.type === 'assistant' && json.message?.content) {
        const parts: string[] = [];
        for (const block of json.message.content) {
            if (block.type === 'text' && block.text) {
                parts.push(block.text);
            } else if (block.type === 'tool_use' && block.name) {
                parts.push(`[tool: ${block.name}]`);
            }
        }
        return parts.length > 0 ? parts.join('\n') : null;
    }
    return null;
}
