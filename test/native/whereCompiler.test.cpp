#include "../../native/vscode-reg-native/whereCompiler.h"

#include <functional>
#include <iostream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace {
struct CompileCase {
    std::string_view expression;
    std::string_view expected;
};

void expectEqual(std::string_view expression, std::string_view expected) {
    const std::string actual = compileWhere(expression);
    if (actual != expected) {
        throw std::runtime_error("Expected [" + std::string(expected) + "] but got [" + actual + "]");
    }
}

void expectRejected(std::string_view expression, std::string_view expectedMessage) {
    try {
        static_cast<void>(compileWhere(expression));
    } catch (const std::invalid_argument& error) {
        if (std::string_view(error.what()).find(expectedMessage) != std::string_view::npos) { return; }
        throw std::runtime_error("Unexpected error for [" + std::string(expression) + "]: " + error.what());
    }
    throw std::runtime_error("Expression was accepted unexpectedly: " + std::string(expression));
}
}

int main() {
    try {
        const std::vector<CompileCase> accepted = {
            {"kind = 'value' AND data LIKE '42 (%'", "kind = 'value' AND data LIKE '42 (%'"},
            {"PATH glob \"Software*\" or lastWrite is null", "key_path GLOB 'Software*' OR last_write IS NULL"},
            {"name IN ('One', 'Two') AND size >= 10", "value_name IN ('One', 'Two') AND value_size >= 10"},
            {"type_code <> 4 OR value_size == 3.5", "type_code <> 4 OR value_size == 3.5"},
            {"size < 10 OR size <= 20 OR size > 30", "value_size < 10 OR value_size <= 20 OR value_size > 30"},
            {"data LIKE '100!%' ESCAPE '!'", "data LIKE '100!%' ESCAPE '!'"},
            {"name = 'O''Reilly'", "value_name = 'O''Reilly'"},
            {"name = \"O'Reilly\"", "value_name = 'O''Reilly'"},
            {"NOT (key = 'Child' AND type != 'REG_SZ')", "NOT (key_path = 'Child' AND value_type != 'REG_SZ')"},
        };
        for (const auto& test : accepted) { expectEqual(test.expression, test.expected); }

        expectRejected("", "must not be empty");
        expectRejected("   ", "must not be empty");
        expectRejected("unknown = 1", "Unsupported identifier");
        expectRejected("name = 'unterminated", "Unterminated string literal");
        expectRejected("size = 1abc", "Invalid numeric literal");
        expectRejected("size = 1.", "Invalid numeric literal");
        expectRejected("kind = 'value'; DROP TABLE records", "Unsupported character");
        expectRejected("size ! 1", "Invalid comparison operator");
        std::cout << "WHERE compiler tests passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}