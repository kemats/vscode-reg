#include "whereCompiler.h"

#include <algorithm>
#include <cctype>
#include <stdexcept>
#include <utility>
#include <vector>

std::string compileWhere(std::string_view expression) {
    static const std::vector<std::pair<std::string_view, std::string_view>> words = {
        {"and", "AND"}, {"or", "OR"}, {"not", "NOT"}, {"in", "IN"}, {"like", "LIKE"},
        {"glob", "GLOB"}, {"is", "IS"}, {"null", "NULL"}, {"escape", "ESCAPE"},
        {"kind", "kind"}, {"key", "key_path"}, {"path", "key_path"}, {"key_path", "key_path"},
        {"name", "value_name"}, {"value_name", "value_name"}, {"type", "value_type"},
        {"value_type", "value_type"}, {"type_code", "type_code"}, {"size", "value_size"},
        {"value_size", "value_size"}, {"data", "data"}, {"last_write", "last_write"},
        {"lastwrite", "last_write"}
    };
    std::string result;
    for (size_t index = 0; index < expression.size();) {
        const unsigned char character = static_cast<unsigned char>(expression[index]);
        if (std::isspace(character)) { result += ' '; ++index; continue; }
        if (character == '\'' || character == '"') {
            const char quote = static_cast<char>(character);
            result += '\'';
            ++index;
            bool closed = false;
            while (index < expression.size()) {
                const char current = expression[index++];
                if (current == quote) {
                    if (index < expression.size() && expression[index] == quote) {
                        result += quote;
                        if (quote == '\'') { result += quote; }
                        ++index;
                        continue;
                    }
                    closed = true;
                    break;
                }
                if (current == '\'') { result += '\''; }
                result += current;
            }
            if (!closed) { throw std::invalid_argument("Unterminated string literal in WHERE expression"); }
            result += '\'';
            continue;
        }
        if (std::isalpha(character) || character == '_') {
            const size_t start = index++;
            while (index < expression.size()) {
                const unsigned char next = static_cast<unsigned char>(expression[index]);
                if (!std::isalnum(next) && next != '_') { break; }
                ++index;
            }
            std::string token(expression.substr(start, index - start));
            std::transform(token.begin(), token.end(), token.begin(), [](unsigned char value) { return static_cast<char>(std::tolower(value)); });
            const auto match = std::find_if(words.begin(), words.end(), [&](const auto& entry) { return entry.first == token; });
            if (match == words.end()) { throw std::invalid_argument("Unsupported identifier or keyword in WHERE expression: " + token); }
            result += match->second;
            continue;
        }
        if (std::isdigit(character)) {
            const size_t start = index;
            while (index < expression.size() && std::isdigit(static_cast<unsigned char>(expression[index]))) { ++index; }
            if (index < expression.size() && expression[index] == '.') {
                ++index;
                const size_t fractionStart = index;
                while (index < expression.size() && std::isdigit(static_cast<unsigned char>(expression[index]))) { ++index; }
                if (index == fractionStart) { throw std::invalid_argument("Invalid numeric literal in WHERE expression"); }
            }
            if (index < expression.size() && (std::isalnum(static_cast<unsigned char>(expression[index])) || expression[index] == '_' || expression[index] == '.')) {
                throw std::invalid_argument("Invalid numeric literal in WHERE expression");
            }
            result.append(expression.substr(start, index - start));
            continue;
        }
        if (character == '(' || character == ')' || character == ',') {
            result += static_cast<char>(character);
            ++index;
            continue;
        }
        if (character == '=') {
            result += '=';
            ++index;
            if (index < expression.size() && expression[index] == '=') { result += '='; ++index; }
            continue;
        }
        if (character == '!') {
            if (++index >= expression.size() || expression[index] != '=') { throw std::invalid_argument("Invalid comparison operator in WHERE expression"); }
            result += "!=";
            ++index;
            continue;
        }
        if (character == '<' || character == '>') {
            result += static_cast<char>(character);
            ++index;
            if (index < expression.size() && (expression[index] == '=' || (character == '<' && expression[index] == '>'))) {
                result += expression[index++];
            }
            continue;
        }
        throw std::invalid_argument("Unsupported character in WHERE expression");
    }
    if (result.find_first_not_of(' ') == std::string::npos) { throw std::invalid_argument("WHERE expression must not be empty"); }
    return result;
}