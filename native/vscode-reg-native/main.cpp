#include <windows.h>
#include <offreg.h>
#include <winsqlite/winsqlite3.h>
#include <nlohmann/json.hpp>

#include "whereCompiler.h"

#include <algorithm>
#include <charconv>
#include <cstdint>
#include <iomanip>
#include <iostream>
#include <memory>
#include <optional>
#include <sstream>
#include <string>
#include <string_view>
#include <system_error>
#include <vector>

using json = nlohmann::json;

namespace {
constexpr size_t kBinaryPreviewBytes = 128;
constexpr size_t kTextPreviewChars = 4096;
constexpr SIZE_T kMinimumProcessMemory = 256ULL * 1024 * 1024;
constexpr SIZE_T kMaximumProcessMemory = 2ULL * 1024 * 1024 * 1024;

struct HandleCloser {
    void operator()(void* handle) const noexcept { if (handle) { CloseHandle(handle); } }
};
using WindowsHandle = std::unique_ptr<void, HandleCloser>;

struct SqliteCloser {
    void operator()(sqlite3* database) const noexcept { if (database) { sqlite3_close(database); } }
};
using SqliteDatabase = std::unique_ptr<sqlite3, SqliteCloser>;

struct StatementCloser {
    void operator()(sqlite3_stmt* statement) const noexcept { if (statement) { sqlite3_finalize(statement); } }
};
using SqliteStatement = std::unique_ptr<sqlite3_stmt, StatementCloser>;

void checkSqlite(sqlite3* database, int status, const char* operation) {
    if (status != SQLITE_OK && status != SQLITE_DONE && status != SQLITE_ROW) {
        throw std::runtime_error(std::string(operation) + ": " + (database ? sqlite3_errmsg(database) : "SQLite error"));
    }
}

void executeSql(sqlite3* database, const char* sql) {
    char* message = nullptr;
    const int status = sqlite3_exec(database, sql, nullptr, nullptr, &message);
    if (status != SQLITE_OK) {
        const std::string detail = message ? message : sqlite3_errmsg(database);
        sqlite3_free(message);
        throw std::runtime_error("SQLite: " + detail);
    }
}

SqliteStatement prepareSql(sqlite3* database, const char* sql) {
    sqlite3_stmt* raw = nullptr;
    checkSqlite(database, sqlite3_prepare_v2(database, sql, -1, &raw, nullptr), "sqlite3_prepare_v2");
    return SqliteStatement(raw);
}

std::string columnText(sqlite3_stmt* statement, int column) {
    const auto* text = sqlite3_column_text(statement, column);
    return text ? reinterpret_cast<const char*>(text) : std::string{};
}

struct KeyCloser {
    void operator()(void* handle) const noexcept { if (handle) { ORCloseKey(handle); } }
};
using KeyHandle = std::unique_ptr<void, KeyCloser>;

struct HiveCloser {
    void operator()(void* handle) const noexcept { if (handle) { ORCloseHive(handle); } }
};
using HiveHandle = std::unique_ptr<void, HiveCloser>;

class OpenedKey {
public:
    explicit OpenedKey(ORHKEY root) : handle_(root) {}
    explicit OpenedKey(KeyHandle key) : owned_(std::move(key)), handle_(owned_.get()) {}
    ORHKEY get() const { return handle_; }

private:
    KeyHandle owned_;
    ORHKEY handle_;
};

struct ValueRecord {
    std::wstring name;
    DWORD type{};
    std::vector<BYTE> bytes;
};

std::string utf8(std::wstring_view value) {
    if (value.empty()) { return {}; }
    const int size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
    if (size <= 0) { throw std::system_error(GetLastError(), std::system_category(), "WideCharToMultiByte"); }
    std::string result(static_cast<size_t>(size), '\0');
    WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), result.data(), size, nullptr, nullptr);
    return result;
}

std::wstring wide(std::string_view value) {
    if (value.empty()) { return {}; }
    const int size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0);
    if (size <= 0) { throw std::system_error(GetLastError(), std::system_category(), "MultiByteToWideChar"); }
    std::wstring result(static_cast<size_t>(size), L'\0');
    MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), result.data(), size);
    return result;
}

std::string typeName(DWORD type) {
    switch (type) {
    case REG_NONE: return "REG_NONE";
    case REG_SZ: return "REG_SZ";
    case REG_EXPAND_SZ: return "REG_EXPAND_SZ";
    case REG_BINARY: return "REG_BINARY";
    case REG_DWORD: return "REG_DWORD";
    case REG_DWORD_BIG_ENDIAN: return "REG_DWORD_BIG_ENDIAN";
    case REG_LINK: return "REG_LINK";
    case REG_MULTI_SZ: return "REG_MULTI_SZ";
    case REG_RESOURCE_LIST: return "REG_RESOURCE_LIST";
    case REG_FULL_RESOURCE_DESCRIPTOR: return "REG_FULL_RESOURCE_DESCRIPTOR";
    case REG_RESOURCE_REQUIREMENTS_LIST: return "REG_RESOURCE_REQUIREMENTS_LIST";
    case REG_QWORD: return "REG_QWORD";
    default: return "REG_UNKNOWN";
    }
}

std::wstring trimNulls(std::wstring value) {
    while (!value.empty() && value.back() == L'\0') { value.pop_back(); }
    return value;
}

std::wstring formatValue(const ValueRecord& value) {
    if ((value.type == REG_SZ || value.type == REG_EXPAND_SZ || value.type == REG_LINK) && value.bytes.size() >= sizeof(wchar_t)) {
        const auto* data = reinterpret_cast<const wchar_t*>(value.bytes.data());
        const size_t length = std::min(value.bytes.size() / sizeof(wchar_t), kTextPreviewChars);
        return trimNulls(std::wstring(data, data + length));
    }
    if (value.type == REG_MULTI_SZ && value.bytes.size() >= sizeof(wchar_t)) {
        const auto* data = reinterpret_cast<const wchar_t*>(value.bytes.data());
        const size_t length = std::min(value.bytes.size() / sizeof(wchar_t), kTextPreviewChars);
        std::wstring result;
        for (size_t i = 0; i < length && data[i] != L'\0';) {
            if (!result.empty()) { result += L"; "; }
            const size_t start = i;
            while (i < length && data[i] != L'\0') { ++i; }
            result.append(data + start, data + i);
            ++i;
        }
        return result;
    }
    if (value.type == REG_DWORD && value.bytes.size() >= sizeof(DWORD)) {
        const DWORD number = *reinterpret_cast<const DWORD*>(value.bytes.data());
        std::wostringstream output; output << number << L" (0x" << std::hex << std::setw(8) << std::setfill(L'0') << number << L")"; return output.str();
    }
    if (value.type == REG_DWORD_BIG_ENDIAN && value.bytes.size() >= sizeof(DWORD)) {
        const DWORD number = _byteswap_ulong(*reinterpret_cast<const DWORD*>(value.bytes.data()));
        std::wostringstream output; output << number << L" (0x" << std::hex << std::setw(8) << std::setfill(L'0') << number << L")"; return output.str();
    }
    if (value.type == REG_QWORD && value.bytes.size() >= sizeof(ULONGLONG)) {
        const ULONGLONG number = *reinterpret_cast<const ULONGLONG*>(value.bytes.data());
        std::wostringstream output; output << number << L" (0x" << std::hex << std::setw(16) << std::setfill(L'0') << number << L")"; return output.str();
    }
    std::wostringstream output;
    const size_t count = std::min(value.bytes.size(), kBinaryPreviewBytes);
    for (size_t i = 0; i < count; ++i) {
        if (i) { output << L' '; }
        output << std::hex << std::setw(2) << std::setfill(L'0') << static_cast<unsigned int>(value.bytes[i]);
    }
    if (value.bytes.size() > count) { output << L" ..."; }
    return output.str();
}

json valueJson(const ValueRecord& value) {
    return {
        {"name", utf8(value.name.empty() ? L"(Default)" : value.name)},
        {"rawName", utf8(value.name)},
        {"type", typeName(value.type)},
        {"typeCode", value.type},
        {"size", value.bytes.size()},
        {"data", utf8(formatValue(value))}
    };
}

class HiveReader {
public:
    HiveReader(const std::wstring& path, std::wstring cachePath, std::string signature)
        : cachePath_(std::move(cachePath)), signature_(std::move(signature)) {
        ORHKEY raw = nullptr;
        const DWORD status = OROpenHive(path.c_str(), &raw);
        if (status != ERROR_SUCCESS) { throw std::system_error(static_cast<int>(status), std::system_category(), "OROpenHive"); }
        hive_.reset(raw);
    }

    json list(std::wstring_view path, DWORD subkeyOffset, DWORD subkeyLimit) {
        OpenedKey key = open(path);
        DWORD subkeyCount = 0, maxSubkey = 0, valueCount = 0, maxValueName = 0, maxValueData = 0;
        FILETIME lastWrite{};
        check(ORQueryInfoKey(key.get(), nullptr, nullptr, &subkeyCount, &maxSubkey, nullptr, &valueCount, &maxValueName, &maxValueData, nullptr, &lastWrite), "ORQueryInfoKey");

        json subkeys = json::array();
        std::vector<wchar_t> name(static_cast<size_t>(maxSubkey) + 2);
        const DWORD subkeyEnd = std::min<DWORD>(subkeyCount, subkeyOffset + subkeyLimit);
        for (DWORD index = subkeyOffset; index < subkeyEnd; ++index) {
            DWORD length = static_cast<DWORD>(name.size()); FILETIME childWrite{};
            check(OREnumKey(key.get(), index, name.data(), &length, nullptr, nullptr, &childWrite), "OREnumKey");
            ORHKEY childRaw = nullptr;
            check(OROpenKey(key.get(), std::wstring(name.data(), length).c_str(), &childRaw), "OROpenKey");
            KeyHandle childKey(childRaw);
            DWORD childSubkeyCount = 0;
            check(ORQueryInfoKey(childKey.get(), nullptr, nullptr, &childSubkeyCount, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr), "ORQueryInfoKey");
            subkeys.push_back({
                {"name", utf8(std::wstring_view(name.data(), length))},
                {"lastWrite", fileTime(childWrite)},
                {"subkeyCount", childSubkeyCount}
            });
        }

        json values = json::array();
        for (DWORD index = 0; index < valueCount; ++index) {
            values.push_back(valueJson(enumValue(key.get(), index, maxValueName, maxValueData)));
        }
        return {
            {"path", utf8(path)},
            {"lastWrite", fileTime(lastWrite)},
            {"subkeyCount", subkeyCount},
            {"subkeyOffset", subkeyOffset},
            {"hasMoreSubkeys", subkeyEnd < subkeyCount},
            {"subkeys", std::move(subkeys)},
            {"values", std::move(values)}
        };
    }

    json search(std::wstring query, size_t limit, std::wstring_view scope) {
        const ULONGLONG started = GetTickCount64();
        bool indexBuilt = false;
        size_t indexedRecords = 0;
        SqliteDatabase database = openSearchDatabase(indexBuilt, indexedRecords);
        const std::string utf8Query = utf8(query);
        const std::string utf8Scope = utf8(scope);
        json results = json::array();
        SqliteStatement statement = prepareSql(database.get(),
            "SELECT kind,key_path,value_name,value_type,type_code,value_size,data,last_write FROM records "
            "WHERE (?2 = '' OR key_path = ?2 OR key_path LIKE ?3 ESCAPE '\\') "
            "AND (key_path LIKE ?1 ESCAPE '\\' OR value_name LIKE ?1 ESCAPE '\\' OR data LIKE ?1 ESCAPE '\\') LIMIT ?4");
        std::string searchExpression = "%";
        for (const char character : utf8Query) {
            if (character == '%' || character == '_' || character == '\\') { searchExpression += '\\'; }
            searchExpression += character;
        }
        searchExpression += '%';
        std::string scopeExpression;
        for (const char character : utf8Scope) {
            if (character == '%' || character == '_' || character == '\\') { scopeExpression += '\\'; }
            scopeExpression += character;
        }
        scopeExpression += "\\\\%";
        checkSqlite(database.get(), sqlite3_bind_text(statement.get(), 1, searchExpression.c_str(), -1, SQLITE_TRANSIENT), "sqlite3_bind_text");
        checkSqlite(database.get(), sqlite3_bind_text(statement.get(), 2, utf8Scope.c_str(), -1, SQLITE_TRANSIENT), "sqlite3_bind_text");
        checkSqlite(database.get(), sqlite3_bind_text(statement.get(), 3, scopeExpression.c_str(), -1, SQLITE_TRANSIENT), "sqlite3_bind_text");
        checkSqlite(database.get(), sqlite3_bind_int(statement.get(), 4, static_cast<int>(limit)), "sqlite3_bind_int");
        while (sqlite3_step(statement.get()) == SQLITE_ROW) {
            const std::string kind = columnText(statement.get(), 0);
            json result = {{"kind", kind}, {"key", columnText(statement.get(), 1)}, {"lastWrite", columnText(statement.get(), 7)}};
            if (kind == "value") {
                const std::string rawName = columnText(statement.get(), 2);
                result["value"] = {
                    {"name", rawName.empty() ? "(Default)" : rawName},
                    {"rawName", rawName},
                    {"type", columnText(statement.get(), 3)},
                    {"typeCode", sqlite3_column_int(statement.get(), 4)},
                    {"size", sqlite3_column_int64(statement.get(), 5)},
                    {"data", columnText(statement.get(), 6)}
                };
            }
            results.push_back(std::move(result));
        }
        return {
            {"query", utf8(query)},
            {"indexedRecords", indexedRecords},
            {"indexBuilt", indexBuilt},
            {"results", std::move(results)},
            {"elapsedMs", GetTickCount64() - started}
        };
    }

    json query(std::string_view where, size_t limit, std::wstring_view scope) {
        const ULONGLONG started = GetTickCount64();
        bool indexBuilt = false;
        size_t indexedRecords = 0;
        SqliteDatabase database = openSearchDatabase(indexBuilt, indexedRecords);
        const std::string utf8Scope = utf8(scope);
        std::string scopeExpression;
        for (const char character : utf8Scope) {
            if (character == '%' || character == '_' || character == '\\') { scopeExpression += '\\'; }
            scopeExpression += character;
        }
        scopeExpression += "\\\\%";
        const std::string sql = "SELECT kind,key_path,value_name,value_type,type_code,value_size,data,last_write FROM records "
            "WHERE (?1 = '' OR key_path = ?1 OR key_path LIKE ?2 ESCAPE '\\') AND (" + compileWhere(where) + ") LIMIT ?3";
        SqliteStatement statement = prepareSql(database.get(), sql.c_str());
        checkSqlite(database.get(), sqlite3_bind_text(statement.get(), 1, utf8Scope.c_str(), -1, SQLITE_TRANSIENT), "sqlite3_bind_text");
        checkSqlite(database.get(), sqlite3_bind_text(statement.get(), 2, scopeExpression.c_str(), -1, SQLITE_TRANSIENT), "sqlite3_bind_text");
        checkSqlite(database.get(), sqlite3_bind_int(statement.get(), 3, static_cast<int>(limit)), "sqlite3_bind_int");
        json results = rowsToResults(statement.get());
        return {{"query", std::string(where)}, {"indexedRecords", indexedRecords}, {"indexBuilt", indexBuilt},
            {"results", std::move(results)}, {"elapsedMs", GetTickCount64() - started}};
    }

    json valueData(std::wstring_view path, std::wstring_view valueName) {
        OpenedKey key = open(path);
        DWORD type = REG_NONE;
        DWORD size = 0;
        const std::wstring ownedName(valueName);
        DWORD status = ORGetValue(key.get(), nullptr, ownedName.c_str(), &type, nullptr, &size);
        if (status != ERROR_SUCCESS && status != ERROR_MORE_DATA) { check(status, "ORGetValue"); }
        constexpr DWORD maximumValueBytes = 64U * 1024U * 1024U;
        if (size > maximumValueBytes) { throw std::runtime_error("Registry value exceeds the 64 MiB detail limit"); }
        std::vector<BYTE> bytes(size);
        if (size) { check(ORGetValue(key.get(), nullptr, ownedName.c_str(), &type, bytes.data(), &size), "ORGetValue"); }
        bytes.resize(size);
        std::wstring acpText;
        if (!bytes.empty()) {
            const int length = MultiByteToWideChar(CP_ACP, 0, reinterpret_cast<const char*>(bytes.data()), static_cast<int>(bytes.size()), nullptr, 0);
            if (length > 0) { acpText.resize(static_cast<size_t>(length)); MultiByteToWideChar(CP_ACP, 0, reinterpret_cast<const char*>(bytes.data()), static_cast<int>(bytes.size()), acpText.data(), length); }
        }
        return {{"name", utf8(valueName)}, {"type", typeName(type)}, {"typeCode", type}, {"size", size},
            {"bytes", bytes}, {"activeCodePage", GetACP()}, {"activeCodePageText", utf8(acpText)}};
    }

    json exportReg(std::wstring_view path, const std::wstring& destination, const std::wstring& rootName) {
        WindowsHandle file(CreateFileW(destination.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr));
        if (!file || file.get() == INVALID_HANDLE_VALUE) { throw std::system_error(GetLastError(), std::system_category(), "CreateFile"); }
        const wchar_t bom = 0xFEFF;
        writeAll(file.get(), std::wstring_view(&bom, 1));
        writeAll(file.get(), L"Windows Registry Editor Version 5.00\r\n\r\n");
        exportKey(file.get(), std::wstring(path), rootName);
        return {{"path", utf8(path)}, {"destination", utf8(destination)}};
    }

private:
    HiveHandle hive_;
    std::wstring cachePath_;
    std::string signature_;

    static void check(DWORD status, const char* operation) {
        if (status != ERROR_SUCCESS) { throw std::system_error(static_cast<int>(status), std::system_category(), operation); }
    }

    static json rowsToResults(sqlite3_stmt* statement) {
        json results = json::array();
        int status = SQLITE_ROW;
        while ((status = sqlite3_step(statement)) == SQLITE_ROW) {
            const std::string kind = columnText(statement, 0);
            json result = {{"kind", kind}, {"key", columnText(statement, 1)}, {"lastWrite", columnText(statement, 7)}};
            if (kind == "value") {
                const std::string rawName = columnText(statement, 2);
                result["value"] = {{"name", rawName.empty() ? "(Default)" : rawName}, {"rawName", rawName},
                    {"type", columnText(statement, 3)}, {"typeCode", sqlite3_column_int(statement, 4)},
                    {"size", sqlite3_column_int64(statement, 5)}, {"data", columnText(statement, 6)}};
            }
            results.push_back(std::move(result));
        }
        if (status != SQLITE_DONE) { throw std::runtime_error("sqlite3_step failed while reading query results"); }
        return results;
    }

    static void writeAll(HANDLE file, std::wstring_view text) {
        const BYTE* current = reinterpret_cast<const BYTE*>(text.data());
        size_t remaining = text.size() * sizeof(wchar_t);
        while (remaining) {
            DWORD written = 0;
            const DWORD chunk = static_cast<DWORD>(std::min<size_t>(remaining, MAXDWORD));
            if (!WriteFile(file, current, chunk, &written, nullptr)) { throw std::system_error(GetLastError(), std::system_category(), "WriteFile"); }
            current += written; remaining -= written;
        }
    }

    static std::wstring quoteReg(std::wstring_view value) {
        std::wstring result = L"\"";
        for (wchar_t character : value) {
            if (character == L'\\' || character == L'\"') { result += L'\\'; }
            result += character;
        }
        result += L'\"';
        return result;
    }

    static std::wstring hexReg(const ValueRecord& value) {
        std::wostringstream output;
        if (value.type == REG_DWORD && value.bytes.size() >= sizeof(DWORD)) {
            output << L"dword:" << std::hex << std::setw(8) << std::setfill(L'0') << *reinterpret_cast<const DWORD*>(value.bytes.data());
            return output.str();
        }
        output << (value.type == REG_BINARY ? L"hex:" : L"hex(" + [&] { std::wostringstream type; type << std::hex << value.type; return type.str(); }() + L"):" );
        for (size_t index = 0; index < value.bytes.size(); ++index) {
            if (index) { output << L','; }
            output << std::hex << std::setw(2) << std::setfill(L'0') << static_cast<unsigned>(value.bytes[index]);
        }
        return output.str();
    }

    void exportKey(HANDLE file, const std::wstring& path, const std::wstring& rootName) {
        OpenedKey key = open(path);
        writeAll(file, L"[" + rootName + (path.empty() ? std::wstring{} : L"\\" + path) + L"]\r\n");
        DWORD subkeyCount = 0, maxSubkey = 0, valueCount = 0, maxValueName = 0, maxValueData = 0;
        check(ORQueryInfoKey(key.get(), nullptr, nullptr, &subkeyCount, &maxSubkey, nullptr, &valueCount, &maxValueName, &maxValueData, nullptr, nullptr), "ORQueryInfoKey");
        for (DWORD index = 0; index < valueCount; ++index) {
            const ValueRecord value = enumValue(key.get(), index, maxValueName, maxValueData);
            const std::wstring name = value.name.empty() ? L"@" : quoteReg(value.name);
            std::wstring data;
            if (value.type == REG_SZ && value.bytes.size() >= sizeof(wchar_t)) {
                data = quoteReg(trimNulls(std::wstring(reinterpret_cast<const wchar_t*>(value.bytes.data()), value.bytes.size() / sizeof(wchar_t))));
            } else { data = hexReg(value); }
            writeAll(file, name + L"=" + data + L"\r\n");
        }
        writeAll(file, L"\r\n");
        std::vector<wchar_t> name(static_cast<size_t>(maxSubkey) + 2);
        for (DWORD index = 0; index < subkeyCount; ++index) {
            DWORD length = static_cast<DWORD>(name.size());
            check(OREnumKey(key.get(), index, name.data(), &length, nullptr, nullptr, nullptr), "OREnumKey");
            const std::wstring child(name.data(), length);
            exportKey(file, path.empty() ? child : path + L"\\" + child, rootName);
        }
    }

    static json fileTime(FILETIME value) {
        SYSTEMTIME utc{};
        if (!FileTimeToSystemTime(&value, &utc)) { return nullptr; }
        char buffer[32];
        std::snprintf(buffer, sizeof(buffer), "%04u-%02u-%02uT%02u:%02u:%02u.%03uZ", utc.wYear, utc.wMonth, utc.wDay, utc.wHour, utc.wMinute, utc.wSecond, utc.wMilliseconds);
        return buffer;
    }

    OpenedKey open(std::wstring_view path) {
        if (path.empty()) { return OpenedKey(hive_.get()); }
        ORHKEY raw = nullptr;
        const std::wstring owned(path);
        check(OROpenKey(hive_.get(), owned.c_str(), &raw), "OROpenKey");
        return OpenedKey(KeyHandle(raw));
    }

    static ValueRecord enumValue(ORHKEY key, DWORD index, DWORD maxName, DWORD maxData) {
        std::vector<wchar_t> name(static_cast<size_t>(maxName) + 2);
        std::vector<BYTE> data(static_cast<size_t>(maxData));
        DWORD nameLength = static_cast<DWORD>(name.size());
        DWORD dataLength = static_cast<DWORD>(data.size());
        DWORD type = REG_NONE;
        check(OREnumValue(key, index, name.data(), &nameLength, &type, data.empty() ? nullptr : data.data(), &dataLength), "OREnumValue");
        data.resize(dataLength);
        return {std::wstring(name.data(), nameLength), type, std::move(data)};
    }

    SqliteDatabase openDatabase() const {
        sqlite3* raw = nullptr;
        const std::string path = utf8(cachePath_);
        checkSqlite(nullptr, sqlite3_open_v2(path.c_str(), &raw, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nullptr), "sqlite3_open_v2");
        SqliteDatabase database(raw);
        sqlite3_busy_timeout(database.get(), 5000);
        return database;
    }

    std::optional<std::pair<std::string, size_t>> readIndexMetadata(sqlite3* database) const {
        sqlite3_stmt* raw = nullptr;
        if (sqlite3_prepare_v2(database, "SELECT last_write FROM records LIMIT 0", -1, &raw, nullptr) != SQLITE_OK) { return std::nullopt; }
        sqlite3_finalize(raw);
        raw = nullptr;
        if (sqlite3_prepare_v2(database, "SELECT signature,record_count FROM metadata LIMIT 1", -1, &raw, nullptr) != SQLITE_OK) { return std::nullopt; }
        SqliteStatement statement(raw);
        if (sqlite3_step(statement.get()) != SQLITE_ROW) { return std::nullopt; }
        return std::pair(columnText(statement.get(), 0), static_cast<size_t>(sqlite3_column_int64(statement.get(), 1)));
    }

    SqliteDatabase openSearchDatabase(bool& indexBuilt, size_t& indexedRecords) {
        SqliteDatabase database = openDatabase();
        const auto metadata = readIndexMetadata(database.get());
        if (metadata && metadata->first == signature_) {
            indexedRecords = metadata->second;
            return database;
        }

        database.reset();
        DeleteFileW(cachePath_.c_str());
        database = openDatabase();
        executeSql(database.get(), "PRAGMA journal_mode=DELETE; PRAGMA synchronous=NORMAL; PRAGMA temp_store=FILE;");
        executeSql(database.get(), "CREATE TABLE metadata(signature TEXT NOT NULL, record_count INTEGER NOT NULL);");
        executeSql(database.get(), "CREATE TABLE records(kind TEXT NOT NULL,key_path TEXT NOT NULL COLLATE NOCASE,value_name TEXT COLLATE NOCASE,value_type TEXT,type_code INTEGER,value_size INTEGER,data TEXT COLLATE NOCASE,last_write TEXT NOT NULL);");
        executeSql(database.get(), "BEGIN IMMEDIATE;");
        try {
            SqliteStatement insert = prepareSql(database.get(), "INSERT INTO records(kind,key_path,value_name,value_type,type_code,value_size,data,last_write) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)");
            buildSearchIndex(L"", database.get(), insert.get(), indexedRecords);
            SqliteStatement metadataInsert = prepareSql(database.get(), "INSERT INTO metadata(signature,record_count) VALUES(?1,?2)");
            checkSqlite(database.get(), sqlite3_bind_text(metadataInsert.get(), 1, signature_.c_str(), -1, SQLITE_TRANSIENT), "sqlite3_bind_text");
            checkSqlite(database.get(), sqlite3_bind_int64(metadataInsert.get(), 2, static_cast<sqlite3_int64>(indexedRecords)), "sqlite3_bind_int64");
            checkSqlite(database.get(), sqlite3_step(metadataInsert.get()), "sqlite3_step");
            executeSql(database.get(), "COMMIT;");
        } catch (...) {
            sqlite3_exec(database.get(), "ROLLBACK;", nullptr, nullptr, nullptr);
            throw;
        }
        indexBuilt = true;
        return database;
    }

    static void bindText(sqlite3* database, sqlite3_stmt* statement, int index, const std::string& value) {
        checkSqlite(database, sqlite3_bind_text(statement, index, value.c_str(), -1, SQLITE_TRANSIENT), "sqlite3_bind_text");
    }

    void insertSearchRecord(sqlite3* database, sqlite3_stmt* statement, const char* kind, const std::wstring& path, const ValueRecord* value, const std::string& lastWrite, size_t& recordCount) {
        sqlite3_reset(statement);
        sqlite3_clear_bindings(statement);
        bindText(database, statement, 1, kind);
        bindText(database, statement, 2, utf8(path));
        if (value) {
            bindText(database, statement, 3, utf8(value->name));
            bindText(database, statement, 4, typeName(value->type));
            checkSqlite(database, sqlite3_bind_int(statement, 5, static_cast<int>(value->type)), "sqlite3_bind_int");
            checkSqlite(database, sqlite3_bind_int64(statement, 6, static_cast<sqlite3_int64>(value->bytes.size())), "sqlite3_bind_int64");
            bindText(database, statement, 7, utf8(formatValue(*value)));
        } else {
            for (int index = 3; index <= 7; ++index) { checkSqlite(database, sqlite3_bind_null(statement, index), "sqlite3_bind_null"); }
        }
        bindText(database, statement, 8, lastWrite);
        checkSqlite(database, sqlite3_step(statement), "sqlite3_step");
        ++recordCount;
    }

    void buildSearchIndex(const std::wstring& path, sqlite3* database, sqlite3_stmt* insert, size_t& recordCount) {
        OpenedKey key = open(path);
        DWORD subkeyCount = 0, maxSubkey = 0, valueCount = 0, maxValueName = 0, maxValueData = 0;
        FILETIME lastWrite{};
        check(ORQueryInfoKey(key.get(), nullptr, nullptr, &subkeyCount, &maxSubkey, nullptr, &valueCount, &maxValueName, &maxValueData, nullptr, &lastWrite), "ORQueryInfoKey");
        const std::string timestamp = fileTime(lastWrite);

        insertSearchRecord(database, insert, "key", path, nullptr, timestamp, recordCount);

        for (DWORD index = 0; index < valueCount; ++index) {
            ValueRecord value = enumValue(key.get(), index, maxValueName, maxValueData);
            insertSearchRecord(database, insert, "value", path, &value, timestamp, recordCount);
        }

        std::vector<wchar_t> name(static_cast<size_t>(maxSubkey) + 2);
        for (DWORD index = 0; index < subkeyCount; ++index) {
            DWORD length = static_cast<DWORD>(name.size());
            check(OREnumKey(key.get(), index, name.data(), &length, nullptr, nullptr, nullptr), "OREnumKey");
            const std::wstring child(name.data(), length);
            buildSearchIndex(path.empty() ? child : path + L"\\" + child, database, insert, recordCount);
        }
    }
};

WindowsHandle applyProcessMemoryLimit(SIZE_T& memoryLimit) {
    MEMORYSTATUSEX memory{sizeof(memory)};
    if (!GlobalMemoryStatusEx(&memory)) { return {}; }
    const SIZE_T requestedLimit = std::clamp<SIZE_T>(static_cast<SIZE_T>(memory.ullAvailPhys / 5), kMinimumProcessMemory, kMaximumProcessMemory);

    WindowsHandle job(CreateJobObjectW(nullptr, nullptr));
    if (!job) { return {}; }
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_PROCESS_MEMORY;
    limits.ProcessMemoryLimit = requestedLimit;
    if (!SetInformationJobObject(job.get(), JobObjectExtendedLimitInformation, &limits, sizeof(limits)) ||
        !AssignProcessToJobObject(job.get(), GetCurrentProcess())) {
        return {};
    }
    memoryLimit = requestedLimit;
    return job;
}
} // namespace

int wmain(int argc, wchar_t** argv) {
    SetConsoleOutputCP(CP_UTF8);
    SetPriorityClass(GetCurrentProcess(), BELOW_NORMAL_PRIORITY_CLASS);
    if (argc != 4) { std::cerr << "Usage: vscode-reg-native.exe <hive> <search-cache> <signature>\n"; return 2; }
    SIZE_T memoryLimit = 0;
    WindowsHandle memoryJob = applyProcessMemoryLimit(memoryLimit);
    try {
        HiveReader reader(argv[1], argv[2], utf8(argv[3]));
        std::cout << json({{"ready", true}, {"memoryLimitBytes", memoryLimit}}).dump() << std::endl;
        std::string line;
        while (std::getline(std::cin, line)) {
            json response;
            try {
                const json request = json::parse(line);
                response["id"] = request.at("id");
                const std::string command = request.at("command");
                if (command == "list") {
                    const DWORD offset = request.value("offset", 0U);
                    const DWORD limit = std::clamp<DWORD>(request.value("limit", 250U), 1, 1000);
                    response["result"] = reader.list(wide(request.value("path", "")), offset, limit);
                } else if (command == "search") {
                    const size_t limit = std::clamp<size_t>(request.value("limit", 100), 1, 500);
                    response["result"] = reader.search(wide(request.at("query").get<std::string>()), limit, wide(request.value("scope", "")));
                } else if (command == "query") {
                    const size_t limit = std::clamp<size_t>(request.value("limit", 100), 1, 500);
                    response["result"] = reader.query(request.at("where").get<std::string>(), limit, wide(request.value("scope", "")));
                } else if (command == "valueData") {
                    response["result"] = reader.valueData(wide(request.value("path", "")), wide(request.value("name", "")));
                } else if (command == "exportReg") {
                    response["result"] = reader.exportReg(wide(request.value("path", "")), wide(request.at("destination").get<std::string>()), wide(request.at("rootName").get<std::string>()));
                } else if (command == "close") {
                    response["result"] = {{"closed", true}};
                    std::cout << response.dump() << std::endl;
                    break;
                } else {
                    throw std::invalid_argument("Unknown command");
                }
            } catch (const std::exception& error) {
                response["error"] = error.what();
            }
            std::cout << response.dump() << std::endl;
        }
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
    return 0;
}
