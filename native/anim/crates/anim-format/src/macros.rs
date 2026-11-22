//! `u8_enum!`: a `repr(u8)` enum with `ALL`, `from_u8` and `id`, for the stored enum fields.

macro_rules! u8_enum {
    ($(#[$m:meta])* pub enum $name:ident { $($(#[$vm:meta])* $v:ident = $n:literal),* $(,)? }) => {
        $(#[$m])*
        #[repr(u8)]
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
        pub enum $name { $($(#[$vm])* $v = $n),* }
        impl $name {
            /// Every value, in id order.
            pub const ALL: &'static [$name] = &[$($name::$v),*];
            /// The value stored as `v`, or `None` for an id this version doesn't define.
            pub fn from_u8(v: u8) -> Option<Self> {
                match v { $($n => Some($name::$v),)* _ => None }
            }
            /// The stored id.
            pub fn id(self) -> u8 {
                self as u8
            }
        }
    };
}

pub(crate) use u8_enum;
