//! Charge-before-allocate wrapper for Study `memory-mib` (ZR-142).
//! Tracks live + peak overlapping engine-owned heap. Not process RSS.
const std = @import("std");
const Allocator = std.mem.Allocator;
const Alignment = std.mem.Alignment;

/// Wrapping allocator: refuse growth that would push `live` past `limit`.
/// `limit == 0` means unlimited (legacy / unset). Thread-safe.
pub const BudgetAllocator = struct {
    parent: Allocator,
    mu: std.Thread.Mutex = .{},
    live_bytes: u64 = 0,
    peak_bytes: u64 = 0,
    /// Hard ceiling in bytes. Zero disables enforcement (still tracks live/peak).
    limit_bytes: u64 = 0,

    pub fn init(parent: Allocator) BudgetAllocator {
        return .{ .parent = parent };
    }

    pub fn allocator(self: *BudgetAllocator) Allocator {
        return .{
            .ptr = self,
            .vtable = &.{
                .alloc = alloc,
                .resize = resize,
                .remap = remap,
                .free = free,
            },
        };
    }

    pub fn live(self: *BudgetAllocator) u64 {
        self.mu.lock();
        defer self.mu.unlock();
        return self.live_bytes;
    }

    pub fn peak(self: *BudgetAllocator) u64 {
        self.mu.lock();
        defer self.mu.unlock();
        return self.peak_bytes;
    }

    pub fn limit(self: *BudgetAllocator) u64 {
        self.mu.lock();
        defer self.mu.unlock();
        return self.limit_bytes;
    }

    pub fn setLimit(self: *BudgetAllocator, bytes: u64) void {
        self.mu.lock();
        defer self.mu.unlock();
        self.limit_bytes = bytes;
    }

    fn fitsLocked(self: *BudgetAllocator, new_live: u64) bool {
        if (self.limit_bytes == 0) return true;
        return new_live <= self.limit_bytes;
    }

    fn noteLiveLocked(self: *BudgetAllocator, new_live: u64) void {
        self.live_bytes = new_live;
        if (new_live > self.peak_bytes) self.peak_bytes = new_live;
        // Peak is monotonic and always covers live.
        std.debug.assert(self.peak_bytes >= self.live_bytes);
        if (self.limit_bytes > 0) std.debug.assert(self.live_bytes <= self.limit_bytes);
    }

    fn chargeGrowLocked(self: *BudgetAllocator, add: u64) bool {
        std.debug.assert(add > 0);
        const new_live = self.live_bytes +% add;
        // Negative space: wrap or over-limit refuses without mutating live/peak.
        if (new_live < self.live_bytes) {
            std.debug.assert(new_live < self.live_bytes);
            return false; // overflow
        }
        if (!self.fitsLocked(new_live)) {
            if (self.limit_bytes > 0) std.debug.assert(new_live > self.limit_bytes);
            return false;
        }
        self.noteLiveLocked(new_live);
        return true;
    }

    fn releaseLocked(self: *BudgetAllocator, sub: u64) void {
        std.debug.assert(sub > 0);
        if (sub >= self.live_bytes) {
            self.live_bytes = 0;
        } else {
            self.live_bytes -= sub;
        }
        // Free never lowers peak; live stays within peak.
        std.debug.assert(self.peak_bytes >= self.live_bytes);
    }

    fn alloc(ctx: *anyopaque, len: usize, alignment: Alignment, ret_addr: usize) ?[*]u8 {
        const self: *BudgetAllocator = @ptrCast(@alignCast(ctx));
        if (len == 0) return self.parent.rawAlloc(0, alignment, ret_addr);

        self.mu.lock();
        const live_before = self.live_bytes;
        const ok = self.chargeGrowLocked(len);
        const live_after_charge = self.live_bytes;
        self.mu.unlock();
        if (!ok) {
            // Refuse path: live unchanged (pair with successful charge below).
            std.debug.assert(live_after_charge == live_before);
            return null;
        }
        std.debug.assert(live_after_charge == live_before + len);

        const ptr = self.parent.rawAlloc(len, alignment, ret_addr) orelse {
            self.mu.lock();
            self.releaseLocked(len);
            // Parent OOM rolls the charge back.
            std.debug.assert(self.live_bytes == live_before);
            self.mu.unlock();
            return null;
        };
        return ptr;
    }

    fn resize(ctx: *anyopaque, memory: []u8, alignment: Alignment, new_len: usize, ret_addr: usize) bool {
        const self: *BudgetAllocator = @ptrCast(@alignCast(ctx));
        const old_len = memory.len;
        if (new_len == old_len) return true;

        if (new_len > old_len) {
            const add = new_len - old_len;
            // Peak while both conceptual sizes exist: charge growth first.
            self.mu.lock();
            const live_before = self.live_bytes;
            const ok = self.chargeGrowLocked(add);
            self.mu.unlock();
            if (!ok) {
                std.debug.assert(self.live() == live_before);
                return false;
            }
            if (!self.parent.rawResize(memory, alignment, new_len, ret_addr)) {
                self.mu.lock();
                self.releaseLocked(add);
                std.debug.assert(self.live_bytes == live_before);
                self.mu.unlock();
                return false;
            }
            return true;
        }

        // Shrink: resize first, then release the tail.
        if (!self.parent.rawResize(memory, alignment, new_len, ret_addr)) return false;
        self.mu.lock();
        self.releaseLocked(old_len - new_len);
        self.mu.unlock();
        return true;
    }

    fn remap(ctx: *anyopaque, memory: []u8, alignment: Alignment, new_len: usize, ret_addr: usize) ?[*]u8 {
        const self: *BudgetAllocator = @ptrCast(@alignCast(ctx));
        const old_len = memory.len;
        if (new_len == old_len) return memory.ptr;
        if (new_len == 0) return null;

        if (new_len > old_len) {
            const add = new_len - old_len;
            // Charge old+new overlap (full new size while old still held conceptually
            // only for the delta; parent remap may keep the same block).
            self.mu.lock();
            const live_before = self.live_bytes;
            const ok = self.chargeGrowLocked(add);
            self.mu.unlock();
            if (!ok) {
                std.debug.assert(self.live() == live_before);
                return null;
            }
            const ptr = self.parent.rawRemap(memory, alignment, new_len, ret_addr) orelse {
                self.mu.lock();
                self.releaseLocked(add);
                std.debug.assert(self.live_bytes == live_before);
                self.mu.unlock();
                return null;
            };
            return ptr;
        }

        const ptr = self.parent.rawRemap(memory, alignment, new_len, ret_addr) orelse return null;
        self.mu.lock();
        self.releaseLocked(old_len - new_len);
        self.mu.unlock();
        return ptr;
    }

    fn free(ctx: *anyopaque, memory: []u8, alignment: Alignment, ret_addr: usize) void {
        const self: *BudgetAllocator = @ptrCast(@alignCast(ctx));
        const len = memory.len;
        self.parent.rawFree(memory, alignment, ret_addr);
        if (len == 0) return;
        self.mu.lock();
        const live_before = self.live_bytes;
        self.releaseLocked(len);
        std.debug.assert(self.live_bytes <= live_before);
        std.debug.assert(self.peak_bytes >= self.live_bytes);
        self.mu.unlock();
    }
};

test "budget allocator refuses over-limit alloc" {
    var budget = BudgetAllocator.init(std.testing.allocator);
    budget.setLimit(64);
    const a = budget.allocator();
    const ok = try a.alloc(u8, 32);
    defer a.free(ok);
    try std.testing.expectError(error.OutOfMemory, a.alloc(u8, 64));
    try std.testing.expectEqual(@as(u64, 32), budget.live());
    try std.testing.expectEqual(@as(u64, 32), budget.peak());
}

test "budget allocator charges resize growth before parent" {
    var budget = BudgetAllocator.init(std.testing.allocator);
    budget.setLimit(48);
    const a = budget.allocator();
    const buf = try a.alloc(u8, 32);
    defer a.free(buf);
    // Growth of 32 would make live 64 > 48.
    try std.testing.expect(!a.resize(buf, 64));
    try std.testing.expectEqual(@as(u64, 32), budget.live());
}

test "unlimited limit still tracks live and peak" {
    var budget = BudgetAllocator.init(std.testing.allocator);
    const a = budget.allocator();
    const x = try a.alloc(u8, 100);
    defer a.free(x);
    const y = try a.alloc(u8, 50);
    try std.testing.expectEqual(@as(u64, 150), budget.live());
    try std.testing.expectEqual(@as(u64, 150), budget.peak());
    a.free(y);
    try std.testing.expectEqual(@as(u64, 100), budget.live());
    try std.testing.expectEqual(@as(u64, 150), budget.peak());
}
