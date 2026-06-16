"""
Services package - exports all services
"""
from .auth import (
    generate_otp,
    hash_password,
    verify_password,
    create_access_token,
    get_current_user,
    is_admin_user,
    require_admin_access,
    has_permission,
    require_permission,
    security,
)

from .audit import log_audit

from .email import (
    send_order_confirmation_email,
    send_invite_email,
    send_order_status_notification,
    send_shop_order_confirmation,
    send_order_confirmation_emails_idempotent,
    send_trade_credit_earned_email,
    RESEND_AVAILABLE,
)

from .name_generator import UniqueNameGenerator, get_name_generator

__all__ = [
    # Auth
    "generate_otp", "hash_password", "verify_password", "create_access_token",
    "get_current_user", "is_admin_user", "require_admin_access",
    "has_permission", "require_permission", "security",
    # Audit
    "log_audit",
    # Email
    "send_order_confirmation_email", "send_invite_email", 
    "send_order_status_notification", "send_shop_order_confirmation",
    "send_order_confirmation_emails_idempotent",
    "send_trade_credit_earned_email",
    "RESEND_AVAILABLE",
]
