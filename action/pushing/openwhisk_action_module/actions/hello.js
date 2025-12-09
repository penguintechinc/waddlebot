/**
 * WaddleBot Hello World Action
 * Simple test action to verify OpenWhisk integration
 *
 * Expected input: { name: "optional name" }
 * Returns: { message: "Hello World", success: true }
 */
function main(params) {
    const name = params.name || 'World';
    return {
        message: `Hello ${name}`,
        success: true
    };
}
