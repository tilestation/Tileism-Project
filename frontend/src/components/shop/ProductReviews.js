import React, { useState, useEffect } from 'react';
import { Star, ThumbsUp, User, CheckCircle } from 'lucide-react';
import { api } from '../../lib/api';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Textarea } from '../../components/ui/textarea';
import { useShopAuth } from '../../contexts/ShopAuthContext';
import { toast } from 'sonner';
import { safeToFixed } from '../../utils/safeStr';

export const ProductReviews = ({ productId }) => {
  const { isAuthenticated } = useShopAuth();
  const [reviews, setReviews] = useState([]);
  const [stats, setStats] = useState({ avg_rating: 0, review_count: 0 });
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  
  const [newReview, setNewReview] = useState({
    rating: 5,
    title: '',
    comment: ''
  });

  useEffect(() => {
    fetchReviews();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId]);

  const fetchReviews = async () => {
    try {
      const response = await api.shopGetProductReviews(productId);
      setReviews(response.data.reviews);
      setStats({
        avg_rating: response.data.avg_rating,
        review_count: response.data.review_count
      });
    } catch (error) {
      console.error('Failed to load reviews:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmitReview = async (e) => {
    e.preventDefault();
    
    if (!isAuthenticated) {
      toast.error('Please sign in to leave a review');
      return;
    }

    setSubmitting(true);
    try {
      const token = localStorage.getItem('shop_token');
      await api.shopCreateProductReview(token, productId, newReview);
      toast.success('Review submitted!');
      setShowForm(false);
      setNewReview({ rating: 5, title: '', comment: '' });
      fetchReviews();
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Failed to submit review');
    } finally {
      setSubmitting(false);
    }
  };

  const handleMarkHelpful = async (reviewId) => {
    try {
      await api.shopMarkReviewHelpful(reviewId);
      toast.success('Marked as helpful');
      fetchReviews();
    } catch (error) {
      toast.error('Failed to mark as helpful');
    }
  };

  const renderStars = (rating, interactive = false, onChange = null) => {
    return (
      <div className="flex items-center gap-0.5">
        {[1, 2, 3, 4, 5].map((star) => (
          <button
            key={star}
            type={interactive ? 'button' : undefined}
            onClick={interactive ? () => onChange?.(star) : undefined}
            className={interactive ? 'cursor-pointer hover:scale-110 transition-transform' : ''}
            disabled={!interactive}
          >
            <Star
              className={`w-5 h-5 ${
                star <= rating
                  ? 'fill-amber-400 text-amber-400'
                  : 'fill-gray-200 text-gray-200'
              }`}
            />
          </button>
        ))}
      </div>
    );
  };

  const formatDate = (dateStr) => {
    return new Date(dateStr).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric'
    });
  };

  return (
    <div className="mt-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold text-slate-900">Customer Reviews</h2>
          <div className="flex items-center gap-2 mt-1">
            {renderStars(Math.round(stats.avg_rating))}
            <span className="text-sm text-slate-500">
              {safeToFixed(stats.avg_rating, 1)} out of 5 ({stats.review_count} reviews)
            </span>
          </div>
        </div>
        
        {isAuthenticated && !showForm && (
          <Button onClick={() => setShowForm(true)} variant="outline">
            Write a Review
          </Button>
        )}
      </div>

      {/* Review Form */}
      {showForm && (
        <Card className="p-6 mb-6">
          <h3 className="font-semibold mb-4">Write Your Review</h3>
          <form onSubmit={handleSubmitReview} className="space-y-4">
            <div>
              <Label>Your Rating</Label>
              <div className="mt-1">
                {renderStars(newReview.rating, true, (rating) => 
                  setNewReview(prev => ({ ...prev, rating }))
                )}
              </div>
            </div>
            
            <div>
              <Label htmlFor="review-title">Review Title</Label>
              <Input
                id="review-title"
                placeholder="Summarize your experience"
                value={newReview.title}
                onChange={(e) => setNewReview(prev => ({ ...prev, title: e.target.value }))}
              />
            </div>
            
            <div>
              <Label htmlFor="review-comment">Your Review</Label>
              <Textarea
                id="review-comment"
                placeholder="Tell others about your experience with this product"
                value={newReview.comment}
                onChange={(e) => setNewReview(prev => ({ ...prev, comment: e.target.value }))}
                rows={4}
              />
            </div>
            
            <div className="flex gap-2">
              <Button type="submit" disabled={submitting}>
                {submitting ? 'Submitting...' : 'Submit Review'}
              </Button>
              <Button type="button" variant="outline" onClick={() => setShowForm(false)}>
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      )}

      {/* Reviews List */}
      {loading ? (
        <div className="space-y-4">
          {[...Array(3)].map((_, i) => (
            <Card key={i} className="p-4 animate-pulse">
              <div className="h-4 bg-gray-200 rounded w-1/4 mb-2"></div>
              <div className="h-3 bg-gray-200 rounded w-3/4"></div>
            </Card>
          ))}
        </div>
      ) : reviews.length === 0 ? (
        <Card className="p-8 text-center">
          <p className="text-slate-500">No reviews yet. Be the first to review this product!</p>
          {!isAuthenticated && (
            <p className="text-sm text-slate-400 mt-2">Sign in to leave a review</p>
          )}
        </Card>
      ) : (
        <div className="space-y-4">
          {reviews.map((review) => (
            <Card key={review.id} className="p-4">
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    {renderStars(review.rating)}
                    {review.verified_purchase && (
                      <span className="flex items-center gap-1 text-xs text-green-600">
                        <CheckCircle className="w-3 h-3" />
                        Verified Purchase
                      </span>
                    )}
                  </div>
                  {review.title && (
                    <h4 className="font-semibold mt-1">{review.title}</h4>
                  )}
                </div>
                <span className="text-xs text-slate-400">{formatDate(review.created_at)}</span>
              </div>
              
              {review.comment && (
                <p className="text-slate-600 mt-2">{review.comment}</p>
              )}
              
              <div className="flex items-center justify-between mt-3 pt-3 border-t">
                <div className="flex items-center gap-2 text-sm text-slate-500">
                  <User className="w-4 h-4" />
                  {review.customer_name}
                </div>
                <button
                  onClick={() => handleMarkHelpful(review.id)}
                  className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"
                >
                  <ThumbsUp className="w-4 h-4" />
                  Helpful ({review.helpful_count || 0})
                </button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
};

export default ProductReviews;
