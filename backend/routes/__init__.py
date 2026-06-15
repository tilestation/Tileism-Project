"""
Routes package - exports all route modules
"""
from fastapi import APIRouter

# Import all routers
from .showrooms import router as showrooms_router
from .staff_pins import router as staff_pins_router
from .customers import router as customers_router
from .admin import router as admin_router
from .audit import router as audit_router
from .invites import router as invites_router
from .orders import router as orders_router
from .deliveries import router as deliveries_router
from .quotations import router as quotations_router
from .cash_quotations import router as cash_quotations_router
from .invoices import router as invoices_router
from .analytics import router as analytics_router
from .live_analytics import router as live_analytics_router
from .refunds import router as refunds_router
from .credit_notes import router as credit_notes_router
from .chat import router as chat_router
from .tiles_info import router as tiles_info_router
from .trade_list import router as trade_list_router
from .trade_accounts import router as trade_accounts_router
from .historical_sales import router as historical_sales_router
from .shop import router as shop_router
from .import_routes import router as import_router
from .tasks import router as tasks_router
from .sms import router as sms_router
from .reports import router as reports_router
from .cash_counter import router as cash_counter_router
from .scraper import router as scraper_router
from .stock_reports import router as stock_reports_router
from .stock_import import router as stock_import_router
from .bulk_stock import router as bulk_stock_router
from .suppliers import router as suppliers_router
from .stock_sync import router as stock_sync_router
from .tiles import router as tiles_router
from .content import router as content_router
from .website_admin import router as website_admin_router
from .supplier_sync import router as supplier_sync_router
from .sync_staging import router as sync_staging_router
from .abandoned_carts import router as abandoned_carts_router
from .recommendations import router as recommendations_router
from .conversion_analytics import router as conversion_analytics_router
from .staff_leaderboard import router as staff_leaderboard_router
from .quote_recovery import router as quote_recovery_router
from .reviews import router as reviews_router
from .recently_viewed import router as recently_viewed_router
from .staff_performance import router as staff_performance_router
from .loyalty import router as loyalty_router
from .sms_updates import router as sms_updates_router
from .monitoring import router as monitoring_router
from .health import router as health_router
from .training_booklet import router as training_booklet_router
from .notifications import router as notifications_router
from .client_errors import router as client_errors_router
from .reorder_suggestions import router as reorder_suggestions_router
from .reorder_points import router as reorder_points_router
from .stock_transfers import router as stock_transfers_router
from .batch_tracking import router as batch_tracking_router
from .barcode_scanner import router as barcode_scanner_router
from .documents import router as documents_router
from .image_migration import router as image_migration_router
from .proforma_invoices import router as proforma_invoices_router
from .filters import router as filters_router
from .specifications import router as specifications_router
from .live_chat import router as live_chat_router
from .product_documents import router as product_documents_router
from .supplier_import import router as supplier_import_router
from .whatsapp import router as whatsapp_router
from .bathroom import router as bathroom_router
from .supplier_health import router as supplier_health_router
from .bulk_edit_tools import router as bulk_edit_tools_router
from .storefront_health import router as storefront_health_router
from .wallet_express import router as wallet_express_router, serve_apple_pay_association
from .permissions import router as permissions_router
from .weekly_digest import router as weekly_digest_router
from .storefront_features import router as storefront_features_router
from .marketing_funnel import router as marketing_funnel_router
from .storefront_messages import router as storefront_messages_router
from .trade_credit_statements import router as trade_credit_statements_router
from .trader_self_service import router as trader_self_service_router
from .email_hub import router as email_hub_router
from .pinterest_pack import router as pinterest_pack_router
from .stripe_reconcile import router as stripe_reconcile_router
from .marketing_admin import router as marketing_admin_router
from .seo_drafts import router as seo_drafts_router
from .search_insights import router as search_insights_router
from .seo_command import router as seo_command_router
from .city_landing_pages import router as city_landing_pages_router, public_router as city_landing_pages_public_router
from .failed_payments import router as failed_payments_router
from .seo_public import router as seo_public_router
from .gsc_auth import router as gsc_auth_router
from .gbp_auth import router as gbp_auth_router
from .ads_savings import router as ads_savings_router
from .notification_prefs import router as notification_prefs_router
from .seo_autopilot import router as seo_autopilot_router
from .seo_autopilot_admin import router as seo_autopilot_admin_router
from .mission_admin import router as mission_admin_router
from .seo_health_status import router as seo_health_status_router
from .visualizer import router as visualizer_router, admin_router as visualizer_admin_router
from .marketing_studio import router as marketing_studio_router, public_router as marketing_studio_public_router
from .radio_studio import router as radio_studio_router, public_router as radio_studio_public_router
from .marketing_videos import router as marketing_videos_router, public_router as marketing_videos_public_router
from .editorial_autopilot import admin_router as editorial_autopilot_admin_router, public_router as editorial_autopilot_public_router
from .google_shopping_feed import router as google_shopping_feed_router
from .stealth_seo import router as stealth_seo_router, public_router as stealth_seo_public_router
from .web_push import router as web_push_router
from .health_critical import router as health_critical_router
from .public_status import router as public_status_router
from .uptime import router as uptime_router
from services.web_vitals import router as web_vitals_router
from .conversion import router as conversion_router
from .sample_followups import router as sample_followups_router
from .pallet_pricing_admin import router as pallet_pricing_admin_router
from .ticket_batches import router as ticket_batches_router
from .uptime_monitor import router as uptime_monitor_router
from .version_info import router as version_info_router
from .version_drift import router as version_drift_router
from .seo_recrawl import router as seo_recrawl_router
from .indexnow import router as indexnow_router
from .data_hygiene import router as data_hygiene_router
from .invoice_bulk_pdf import router as invoice_bulk_pdf_router
from .staff_photos import router as staff_photos_router
from .staff_monthly_report import router as staff_monthly_report_router
from .auto_exports import router as auto_exports_router
from .hr_employees import router as hr_employees_router
from .hr_leave import router as hr_leave_router
from .hr_documents import router as hr_documents_router
from .hr_time_tracking import router as hr_time_tracking_router

# Create main API router that includes all sub-routers
api_router = APIRouter()

# Include all routers
api_router.include_router(showrooms_router)
api_router.include_router(staff_pins_router)
api_router.include_router(customers_router)
api_router.include_router(admin_router)
api_router.include_router(audit_router)
api_router.include_router(invites_router)
api_router.include_router(orders_router)
api_router.include_router(deliveries_router)
api_router.include_router(quotations_router)
api_router.include_router(cash_quotations_router)
api_router.include_router(invoices_router)
api_router.include_router(analytics_router)
api_router.include_router(live_analytics_router)
api_router.include_router(refunds_router)
api_router.include_router(credit_notes_router)
api_router.include_router(chat_router)
api_router.include_router(tiles_info_router)
api_router.include_router(trade_list_router)
api_router.include_router(trade_accounts_router)
api_router.include_router(historical_sales_router)
api_router.include_router(shop_router)
api_router.include_router(import_router)
api_router.include_router(tasks_router)
api_router.include_router(sms_router)
api_router.include_router(reports_router)
api_router.include_router(cash_counter_router)
api_router.include_router(scraper_router)
api_router.include_router(stock_reports_router)
api_router.include_router(stock_import_router)
api_router.include_router(bulk_stock_router)
api_router.include_router(suppliers_router)
api_router.include_router(stock_sync_router)
api_router.include_router(tiles_router)
api_router.include_router(content_router)
api_router.include_router(website_admin_router)
api_router.include_router(supplier_sync_router)
api_router.include_router(sync_staging_router)
api_router.include_router(abandoned_carts_router)
api_router.include_router(recommendations_router)
api_router.include_router(conversion_analytics_router)
api_router.include_router(staff_leaderboard_router)
api_router.include_router(quote_recovery_router)
api_router.include_router(reviews_router)
api_router.include_router(recently_viewed_router)
api_router.include_router(staff_performance_router)
api_router.include_router(loyalty_router)
api_router.include_router(marketing_admin_router)
api_router.include_router(seo_drafts_router)
api_router.include_router(search_insights_router)
api_router.include_router(seo_command_router)
api_router.include_router(city_landing_pages_router)
api_router.include_router(city_landing_pages_public_router)
api_router.include_router(failed_payments_router)
api_router.include_router(seo_public_router)
api_router.include_router(gsc_auth_router)
api_router.include_router(gbp_auth_router)
api_router.include_router(ads_savings_router)
api_router.include_router(notification_prefs_router)
api_router.include_router(seo_autopilot_router)
api_router.include_router(seo_autopilot_admin_router)
api_router.include_router(mission_admin_router)
api_router.include_router(seo_health_status_router)
api_router.include_router(visualizer_router)
api_router.include_router(visualizer_admin_router)
api_router.include_router(marketing_studio_router)
api_router.include_router(marketing_studio_public_router)
api_router.include_router(marketing_videos_router)
api_router.include_router(marketing_videos_public_router)
api_router.include_router(editorial_autopilot_admin_router)
api_router.include_router(editorial_autopilot_public_router)
api_router.include_router(google_shopping_feed_router)
api_router.include_router(stealth_seo_router)
api_router.include_router(stealth_seo_public_router)
api_router.include_router(web_push_router)
api_router.include_router(health_critical_router)
api_router.include_router(public_status_router)
api_router.include_router(web_vitals_router)
api_router.include_router(uptime_router)
api_router.include_router(conversion_router)
api_router.include_router(sample_followups_router)
api_router.include_router(pallet_pricing_admin_router)
api_router.include_router(ticket_batches_router)
api_router.include_router(uptime_monitor_router)
api_router.include_router(version_info_router)
api_router.include_router(version_drift_router)
api_router.include_router(seo_recrawl_router)
api_router.include_router(indexnow_router)
api_router.include_router(data_hygiene_router)
api_router.include_router(invoice_bulk_pdf_router)
api_router.include_router(staff_photos_router)
api_router.include_router(staff_monthly_report_router)
api_router.include_router(auto_exports_router)
api_router.include_router(hr_employees_router)
api_router.include_router(hr_leave_router)
api_router.include_router(hr_documents_router)
api_router.include_router(hr_time_tracking_router)
api_router.include_router(sms_updates_router)
api_router.include_router(monitoring_router)
api_router.include_router(health_router)
api_router.include_router(training_booklet_router)
api_router.include_router(notifications_router)
api_router.include_router(client_errors_router)
api_router.include_router(reorder_suggestions_router)
api_router.include_router(reorder_points_router)
api_router.include_router(stock_transfers_router)
api_router.include_router(batch_tracking_router)
api_router.include_router(barcode_scanner_router)
api_router.include_router(documents_router)
api_router.include_router(image_migration_router)
api_router.include_router(proforma_invoices_router)
api_router.include_router(filters_router)
api_router.include_router(specifications_router)
api_router.include_router(live_chat_router)
api_router.include_router(product_documents_router)
api_router.include_router(supplier_import_router)
api_router.include_router(whatsapp_router)
api_router.include_router(bathroom_router)
api_router.include_router(supplier_health_router)
api_router.include_router(bulk_edit_tools_router)
api_router.include_router(storefront_health_router)
api_router.include_router(wallet_express_router)
api_router.include_router(permissions_router)
api_router.include_router(weekly_digest_router)
api_router.include_router(storefront_features_router)
api_router.include_router(marketing_funnel_router)
api_router.include_router(storefront_messages_router)
api_router.include_router(trade_credit_statements_router)
api_router.include_router(trader_self_service_router)
api_router.include_router(email_hub_router)
api_router.include_router(pinterest_pack_router)
api_router.include_router(stripe_reconcile_router)
api_router.include_router(radio_studio_router)
api_router.include_router(radio_studio_public_router)
__all__ = [
    "api_router",
    "showrooms_router",
    "staff_pins_router", 
    "customers_router",
    "admin_router",
    "audit_router",
    "invites_router",
    "orders_router",
    "deliveries_router",
    "quotations_router",
    "cash_quotations_router",
    "invoices_router",
    "analytics_router",
    "refunds_router",
    "credit_notes_router",
    "historical_sales_router",
    "shop_router",
    "import_router",
    "sms_router",
]

