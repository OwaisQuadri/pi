const std = @import("std");
const FILE = anyopaque;
extern "c" fn fopen([*:0]const u8, [*:0]const u8) ?*FILE;
extern "c" fn fclose(*FILE) c_int;
extern "c" fn getline(*?[*]u8, *usize, *FILE) isize;
extern "c" fn free(?*anyopaque) void;
extern "c" fn printf([*:0]const u8, ...) c_int;
extern "c" fn fflush(?*FILE) c_int;
extern "c" fn sleep(c_uint) c_uint;

fn textBytes(entry: std.json.Value) usize {
    if (entry != .object) return 0;
    const message = entry.object.get("message") orelse return 0;
    if (message != .object) return 0;
    const content = message.object.get("content") orelse return 0;
    if (content != .array or content.array.items.len == 0) return 0;
    const part = content.array.items[0];
    if (part != .object) return 0;
    const text = part.object.get("text") orelse return 0;
    return if (text == .string) text.string.len else 0;
}

fn isValidHeader(entry: std.json.Value) bool {
    if (entry != .object) return false;
    const kind = entry.object.get("type") orelse return false;
    const id = entry.object.get("id") orelse return false;
    return kind == .string and std.mem.eql(u8, kind.string, "session") and id == .string;
}

fn run(path: [*:0]const u8) !void {
    const file = fopen(path, "r") orelse return error.CannotOpenSession;
    defer _ = fclose(file);
    var line: ?[*]u8 = null;
    var capacity: usize = 0;
    defer free(if (line) |pointer| @ptrCast(pointer) else null);
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    var entries: std.ArrayList(std.json.Value) = .empty;
    var text_bytes: usize = 0;
    while (true) {
        const length = getline(&line, &capacity, file);
        if (length < 0) break;
        const content = std.mem.trim(u8, line.?[0..@intCast(length)], " \t\r\n");
        if (content.len == 0) continue;
        const entry = std.json.parseFromSliceLeaky(std.json.Value, allocator, content, .{ .allocate = .alloc_always }) catch |err| {
            if (err == error.OutOfMemory) return err;
            continue;
        };
        text_bytes += textBytes(entry);
        try entries.append(allocator, entry);
    }
    if (entries.items.len == 0 or !isValidHeader(entries.items[0])) {
        entries.clearRetainingCapacity();
        text_bytes = 0;
    }
    _ = printf("READY %zu %zu\n", entries.items.len, text_bytes);
    _ = fflush(null);
    _ = sleep(2);
    std.mem.doNotOptimizeAway(entries.items);
}

pub export fn main(argc: c_int, argv: [*][*:0]u8) c_int {
    if (argc != 2) return 2;
    run(argv[1]) catch return 1;
    return 0;
}
